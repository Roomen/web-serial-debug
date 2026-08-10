// BLU 功耗分析：选择区统计 / 事件 / FFT / 电池 / 周期叠画（纯计算，无 DOM）
// 由 blu-power.js 在框选后调用。
(function (global) {
	'use strict'

	function isFiniteNum(v) {
		return typeof v === 'number' && isFinite(v)
	}

	function nextPow2(n) {
		let p = 1
		while (p < n) p <<= 1
		return p
	}

	/** 简易统计：avg / min / max / rms / pp / sum / n */
	function basicStats(samples) {
		const out = {
			n: 0, avg: 0, min: 0, max: 0, rms: 0, pp: 0, sum: 0, sumSq: 0,
		}
		if (!samples || !samples.length) return out
		let min = Infinity
		let max = -Infinity
		let sum = 0
		let sumSq = 0
		let n = 0
		for (let i = 0; i < samples.length; i++) {
			const v = samples[i]
			if (!isFiniteNum(v)) continue
			n++
			sum += v
			sumSq += v * v
			if (v < min) min = v
			if (v > max) max = v
		}
		if (!n) return out
		out.n = n
		out.sum = sum
		out.sumSq = sumSq
		out.avg = sum / n
		out.min = min
		out.max = max
		out.pp = max - min
		out.rms = Math.sqrt(sumSq / n)
		return out
	}

	/**
	 * 双电平：按阈值将样点分为高/低态。
	 * thr 缺省 = (min+max)/2；hyst 为滞回半宽（µA）。
	 */
	function twoLevelStats(samples, thr, hyst) {
		const base = basicStats(samples)
		const out = {
			thr: thr,
			hyst: hyst || 0,
			lowAvg: null,
			highAvg: null,
			lowN: 0,
			highN: 0,
			duty: null, // 高态占比（样点比）
			lowChargeShare: null,
			highChargeShare: null,
		}
		if (!base.n) return out
		if (thr == null || !isFiniteNum(thr)) {
			thr = (base.min + base.max) * 0.5
		}
		out.thr = thr
		const h = isFiniteNum(hyst) ? Math.abs(hyst) : Math.max(base.pp * 0.02, 1e-6)
		out.hyst = h
		const thrHi = thr + h
		const thrLo = thr - h
		let lowSum = 0
		let highSum = 0
		let lowN = 0
		let highN = 0
		let state = 0 // -1 low, 1 high
		for (let i = 0; i < samples.length; i++) {
			const v = samples[i]
			if (!isFiniteNum(v)) continue
			if (state <= 0 && v >= thrHi) state = 1
			else if (state >= 0 && v <= thrLo) state = -1
			else if (state === 0) {
				if (v >= thr) state = 1
				else state = -1
			}
			if (state > 0) {
				highSum += v
				highN++
			} else {
				lowSum += v
				lowN++
			}
		}
		out.lowN = lowN
		out.highN = highN
		if (lowN) out.lowAvg = lowSum / lowN
		if (highN) out.highAvg = highSum / highN
		const total = lowN + highN
		if (total > 0) {
			out.duty = highN / total
			const totSum = lowSum + highSum
			if (Math.abs(totSum) > 1e-18) {
				out.lowChargeShare = lowSum / totSum
				out.highChargeShare = highSum / totSum
			}
		}
		return out
	}

	/**
	 * 尖峰检测：超过 threshold 的连续区段。
	 * opts: { thr, minWidthPts, maxCount, mode: 'above'|'abs' }
	 */
	function findSpikes(samples, opts) {
		opts = opts || {}
		const list = []
		if (!samples || samples.length < 2) return list
		const base = basicStats(samples)
		let thr = opts.thr
		if (thr == null || !isFiniteNum(thr)) {
			// 默认：均值 + 3σ 与 70% 量程取较大
			const var0 = Math.max(0, base.sumSq / base.n - base.avg * base.avg)
			const sigma = Math.sqrt(var0)
			thr = Math.max(base.avg + 3 * sigma, base.min + 0.7 * base.pp)
		}
		const minW = opts.minWidthPts != null ? opts.minWidthPts : 1
		const maxCount = opts.maxCount != null ? opts.maxCount : 200
		const mode = opts.mode || 'above'
		let i = 0
		const n = samples.length
		while (i < n && list.length < maxCount) {
			const v = samples[i]
			const hit = isFiniteNum(v) && (mode === 'abs' ? Math.abs(v) >= thr : v >= thr)
			if (!hit) {
				i++
				continue
			}
			const start = i
			let peak = v
			let peakIdx = i
			let sum = 0
			let cnt = 0
			while (i < n) {
				const u = samples[i]
				const ok = isFiniteNum(u) && (mode === 'abs' ? Math.abs(u) >= thr : u >= thr)
				if (!ok) break
				sum += u
				cnt++
				if (mode === 'abs' ? Math.abs(u) > Math.abs(peak) : u > peak) {
					peak = u
					peakIdx = i
				}
				i++
			}
			const end = i - 1
			const width = end - start + 1
			if (width >= minW) {
				list.push({
					start: start,
					end: end,
					peakIdx: peakIdx,
					peak: peak,
					avg: cnt ? sum / cnt : peak,
					sum: sum,
					widthPts: width,
				})
			}
		}
		// 按峰值降序
		list.sort(function (a, b) {
			return Math.abs(b.peak) - Math.abs(a.peak)
		})
		return list
	}

	/**
	 * 按阈值分段（Sleep/Active 风格）。
	 * 返回 { segments, thr }；segment: { kind:'low'|'high', start, end, avgI, sum, n }
	 */
	function segmentByThreshold(samples, thr, opts) {
		opts = opts || {}
		const segments = []
		if (!samples || !samples.length) return { segments: segments, thr: thr }
		const base = basicStats(samples)
		if (thr == null || !isFiniteNum(thr)) thr = (base.min + base.max) * 0.5
		const minSeg = opts.minSegPts != null ? opts.minSegPts : 2
		const maxSeg = opts.maxCount != null ? opts.maxCount : 500
		let kind = null
		let start = 0
		let sum = 0
		let n = 0
		function flush(end) {
			if (kind == null || n < minSeg) return
			if (segments.length >= maxSeg) return
			segments.push({
				kind: kind,
				start: start,
				end: end,
				avgI: sum / n,
				sum: sum,
				n: n,
			})
		}
		for (let i = 0; i < samples.length; i++) {
			const v = samples[i]
			if (!isFiniteNum(v)) continue
			const k = v >= thr ? 'high' : 'low'
			if (kind == null) {
				kind = k
				start = i
				sum = v
				n = 1
				continue
			}
			if (k === kind) {
				sum += v
				n++
			} else {
				flush(i - 1)
				kind = k
				start = i
				sum = v
				n = 1
			}
		}
		if (kind != null) flush(samples.length - 1)
		return { segments: segments, thr: thr }
	}

	// ---- FFT ----
	function hannWindow(n) {
		const w = new Float64Array(n)
		if (n <= 1) {
			if (n === 1) w[0] = 1
			return w
		}
		for (let i = 0; i < n; i++) {
			w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
		}
		return w
	}

	function flatTopWindow(n) {
		// 近似 flat-top（幅度精度更好）
		const w = new Float64Array(n)
		if (n <= 1) {
			if (n === 1) w[0] = 1
			return w
		}
		const a0 = 1
		const a1 = 1.93
		const a2 = 1.29
		const a3 = 0.388
		const a4 = 0.028
		for (let i = 0; i < n; i++) {
			const x = (2 * Math.PI * i) / (n - 1)
			w[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x) - a3 * Math.cos(3 * x) + a4 * Math.cos(4 * x)
		}
		return w
	}

	/** 原地 radix-2 FFT（re/im 长度 n=2^k） */
	function fftRadix2(re, im) {
		const n = re.length
		// bit-reverse
		let j = 0
		for (let i = 0; i < n; i++) {
			if (i < j) {
				let tr = re[i]; re[i] = re[j]; re[j] = tr
				let ti = im[i]; im[i] = im[j]; im[j] = ti
			}
			let m = n >> 1
			while (m >= 1 && j >= m) {
				j -= m
				m >>= 1
			}
			j += m
		}
		for (let size = 2; size <= n; size <<= 1) {
			const half = size >> 1
			const tableStep = Math.PI / half
			for (let i = 0; i < n; i += size) {
				for (let k = 0; k < half; k++) {
					const angle = tableStep * k
					const wr = Math.cos(angle)
					const wi = -Math.sin(angle)
					const ur = re[i + k]
					const ui = im[i + k]
					const vr = re[i + k + half] * wr - im[i + k + half] * wi
					const vi = re[i + k + half] * wi + im[i + k + half] * wr
					re[i + k] = ur + vr
					im[i + k] = ui + vi
					re[i + k + half] = ur - vr
					im[i + k + half] = ui - vi
				}
			}
		}
	}

	/**
	 * 选择区 FFT。
	 * samples: Float32/64 电流 µA；sampleRateHz: 有效采样率（抽稀后）。
	 * opts: { window:'hann'|'flattop'|'rect', nfft, removeDc, topK }
	 */
	function fftAnalysis(samples, sampleRateHz, opts) {
		opts = opts || {}
		const empty = {
			ok: false,
			reason: 'no_data',
			n: 0,
			nfft: 0,
			sampleRateHz: sampleRateHz || 0,
			nyquistHz: 0,
			binHz: 0,
			window: opts.window || 'hann',
			dc: 0,
			mags: null, // Float64Array length nfft/2+1, 单边幅度（µA 峰值近似）
			freqs: null,
			peaks: [],
			removeDc: !!opts.removeDc,
		}
		if (!samples || samples.length < 4 || !sampleRateHz || sampleRateHz <= 0) {
			return empty
		}
		// 收集有限点
		const raw = []
		for (let i = 0; i < samples.length; i++) {
			if (isFiniteNum(samples[i])) raw.push(samples[i])
		}
		if (raw.length < 4) {
			empty.reason = 'too_short'
			return empty
		}
		const maxNfft = opts.maxNfft != null ? opts.maxNfft : 65536
		let nUse = raw.length
		let nfft = opts.nfft
		if (!nfft || nfft < 4) {
			nfft = nextPow2(Math.min(nUse, maxNfft))
			if (nfft > maxNfft) nfft = maxNfft
			// 至少 16
			if (nfft < 16) nfft = 16
		} else {
			nfft = nextPow2(nfft)
			if (nfft > maxNfft) nfft = maxNfft
		}
		// 若样点多于 nfft，均匀抽稀
		let step = 1
		if (nUse > nfft) {
			step = Math.ceil(nUse / nfft)
			nUse = Math.floor(raw.length / step)
		}
		// 有效采样率随抽稀下降
		const fs = sampleRateHz / step
		const winName = opts.window || 'hann'
		const win = winName === 'flattop' ? flatTopWindow(Math.min(nUse, nfft))
			: winName === 'rect' ? null
			: hannWindow(Math.min(nUse, nfft))
		const re = new Float64Array(nfft)
		const im = new Float64Array(nfft)
		const take = Math.min(nUse, nfft)
		let sum = 0
		for (let i = 0; i < take; i++) {
			const v = raw[i * step]
			sum += v
			re[i] = v
		}
		const mean = take ? sum / take : 0
		const removeDc = opts.removeDc !== false // 默认去 DC，谱线更清晰
		let winSum = 0
		for (let i = 0; i < take; i++) {
			let v = re[i]
			if (removeDc) v -= mean
			const w = win ? win[i] : 1
			re[i] = v * w
			winSum += w
		}
		// 窗相干增益归一：单边幅度 ≈ 2/winSum * |X|
		fftRadix2(re, im)
		const half = (nfft >> 1) + 1
		const mags = new Float64Array(half)
		const freqs = new Float64Array(half)
		const scale = winSum > 0 ? (2 / winSum) : (2 / take)
		for (let k = 0; k < half; k++) {
			const mag = Math.hypot(re[k], im[k]) * (k === 0 || k === half - 1 ? scale * 0.5 : scale)
			mags[k] = mag
			freqs[k] = (k * fs) / nfft
		}
		// DC 单独（未去 DC 时 bin0 有意义）
		const dc = mean

		// Top-K 峰值（跳过 bin0）
		const topK = opts.topK != null ? opts.topK : 8
		const peaks = []
		// 噪声底：中位数 * 因子
		const sorted = Array.prototype.slice.call(mags, 1).filter(function (x) { return x > 0 }).sort(function (a, b) { return a - b })
		const med = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : 0
		const floor = Math.max(med * 3, 1e-12)
		for (let k = 2; k < half - 1; k++) {
			const m = mags[k]
			if (m < floor) continue
			if (m >= mags[k - 1] && m >= mags[k + 1]) {
				// 抛物线插值 refinement
				const alpha = mags[k - 1]
				const beta = m
				const gamma = mags[k + 1]
				const denom = alpha - 2 * beta + gamma
				let delta = 0
				if (Math.abs(denom) > 1e-18) delta = 0.5 * (alpha - gamma) / denom
				if (delta > 1) delta = 1
				if (delta < -1) delta = -1
				const freq = ((k + delta) * fs) / nfft
				const mag = beta - 0.25 * (alpha - gamma) * delta
				peaks.push({
					bin: k,
					freqHz: freq,
					magUA: mag,
					periodSec: freq > 0 ? 1 / freq : null,
				})
			}
		}
		peaks.sort(function (a, b) { return b.magUA - a.magUA })
		const top = peaks.slice(0, topK)

		return {
			ok: true,
			reason: '',
			n: take,
			nfft: nfft,
			step: step,
			sampleRateHz: fs,
			inputRateHz: sampleRateHz,
			nyquistHz: fs * 0.5,
			binHz: fs / nfft,
			window: winName,
			dc: dc,
			removeDc: removeDc,
			mags: mags,
			freqs: freqs,
			peaks: top,
			peakCount: peaks.length,
		}
	}

	/**
	 * 电池寿命估算。
	 * avgUA: 平均电流 µA；capacityMah: 电池容量 mAh
	 * opts: { derate: 0.9, cutoffDays }
	 */
	function estimateBatteryLife(avgUA, capacityMah, opts) {
		opts = opts || {}
		const derate = opts.derate != null ? opts.derate : 0.9
		const out = {
			ok: false,
			avgUA: avgUA,
			capacityMah: capacityMah,
			usableMah: 0,
			hours: null,
			days: null,
			years: null,
			reason: '',
		}
		if (!isFiniteNum(avgUA) || avgUA <= 0) {
			out.reason = 'avg_invalid'
			return out
		}
		if (!isFiniteNum(capacityMah) || capacityMah <= 0) {
			out.reason = 'capacity_invalid'
			return out
		}
		const usable = capacityMah * derate
		out.usableMah = usable
		// I(mA) = avgUA / 1000；hours = mAh / mA
		const iMa = avgUA / 1000
		const hours = usable / iMa
		out.hours = hours
		out.days = hours / 24
		out.years = hours / (24 * 365.25)
		out.ok = true
		return out
	}

	/**
	 * 按固定周期切段叠画。
	 * periodPts: 每周期样点数；maxCycles 上限。
	 * 返回 { cycles: Float64Array[], mean, nCycles, periodPts }
	 */
	function extractCycles(samples, periodPts, maxCycles) {
		const out = {
			cycles: [],
			mean: null,
			nCycles: 0,
			periodPts: periodPts | 0,
		}
		periodPts = periodPts | 0
		if (!samples || periodPts < 4 || samples.length < periodPts * 2) return out
		maxCycles = maxCycles != null ? maxCycles : 32
		const nFull = Math.min(maxCycles, Math.floor(samples.length / periodPts))
		if (nFull < 1) return out
		const mean = new Float64Array(periodPts)
		const cycles = []
		for (let c = 0; c < nFull; c++) {
			const slice = new Float64Array(periodPts)
			const off = c * periodPts
			for (let i = 0; i < periodPts; i++) {
				const v = samples[off + i]
				const u = isFiniteNum(v) ? v : 0
				slice[i] = u
				mean[i] += u
			}
			cycles.push(slice)
		}
		for (let i = 0; i < periodPts; i++) mean[i] /= nFull
		out.cycles = cycles
		out.mean = mean
		out.nCycles = nFull
		return out
	}

	/** 将 charge 从 sum(µA)*dt 估算：sumI * samplePeriodSec */
	function chargeFromSum(sumUA, samplePeriodSec) {
		return sumUA * samplePeriodSec // µC
	}

	global.BluAnalysis = {
		basicStats: basicStats,
		twoLevelStats: twoLevelStats,
		findSpikes: findSpikes,
		segmentByThreshold: segmentByThreshold,
		fftAnalysis: fftAnalysis,
		estimateBatteryLife: estimateBatteryLife,
		extractCycles: extractCycles,
		chargeFromSum: chargeFromSum,
		nextPow2: nextPow2,
		hannWindow: hannWindow,
	}
})(typeof window !== 'undefined' ? window : globalThis)
