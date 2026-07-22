/*
 * 主机侧镜像：按 FlowLogic Protocol/sk/base_seck.c 的帧布局组上行帧、验下行帧。
 * 不链接固件，仅复现帧结构/CRC/TLV 遍历语义，用于与网页 JS 双向交叉测试。
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#define SECK_HEAD1 0xA9
#define SECK_HEAD2 0x9A
#define SECK_END   0x16
#define SECK_VER   0x02
#define SECK_MANUF 0x01
#define SECK_DEV_TYPE 0x05

#define SECK_UP_DATA 24
#define SECK_DOWN_DATA 16
#define SECK_DOWN_LEN 14

/* CRC-16/CCITT-FALSE: poly 0x1021 init 0xFFFF refin=false refout=false */
static uint16_t crc16_ccitt_false(const uint8_t *data, size_t len)
{
	uint16_t crc = 0xFFFF;
	for (size_t i = 0; i < len; i++) {
		crc ^= (uint16_t)data[i] << 8;
		for (int b = 0; b < 8; b++) {
			if (crc & 0x8000) crc = (uint16_t)((crc << 1) ^ 0x1021);
			else crc = (uint16_t)(crc << 1);
		}
	}
	return crc;
}

static void wu16(uint8_t *p, uint16_t v)
{
	p[0] = (uint8_t)(v & 0xff);
	p[1] = (uint8_t)(v >> 8);
}

/* 与 base_seck.c writeBcdTimeToBytes 一致：year 高字节在前，月日时分秒各 1B（BCD 字段） */
static void write_bcd_time_c(uint8_t *p, uint16_t year_bcd, uint8_t mon, uint8_t day,
			     uint8_t hh, uint8_t mm, uint8_t ss)
{
	p[0] = (uint8_t)(year_bcd >> 8);
	p[1] = (uint8_t)(year_bcd & 0xff);
	p[2] = mon;
	p[3] = day;
	p[4] = hh;
	p[5] = mm;
	p[6] = ss;
}

/* 组上行帧：pTlv 为原始 TLV（不含 2B 明文长度），返回总长度 */
static int pack_up(uint8_t *out, size_t cap,
		   uint16_t frame_num, uint8_t func, uint8_t ctrl,
		   const uint8_t unique[7],
		   int16_t rsrp, int16_t snr, uint8_t ecl, uint8_t csq,
		   const uint8_t *tlv, uint16_t tlv_len)
{
	if (cap < (size_t)(SECK_UP_DATA + 2 + tlv_len + 3)) return -1;
	uint8_t *p = out;
	/* data field = plainLen + tlv */
	wu16(p + SECK_UP_DATA, tlv_len);
	memcpy(p + SECK_UP_DATA + 2, tlv, tlv_len);
	uint16_t data_len = (uint16_t)(tlv_len + 2);

	p[0] = SECK_HEAD1;
	p[1] = SECK_HEAD2;
	wu16(p + 2, frame_num);
	p[4] = SECK_VER;
	p[5] = SECK_MANUF;
	p[6] = SECK_DEV_TYPE;
	memcpy(p + 7, unique, 7);
	p[14] = (uint8_t)(rsrp & 0xff);
	p[15] = (uint8_t)((rsrp >> 8) & 0xff);
	p[16] = (uint8_t)(snr & 0xff);
	p[17] = (uint8_t)((snr >> 8) & 0xff);
	p[18] = ecl;
	p[19] = csq;
	p[20] = func;
	p[21] = ctrl;
	wu16(p + 22, data_len);

	uint16_t crc = crc16_ccitt_false(p, SECK_UP_DATA + data_len);
	p[SECK_UP_DATA + data_len] = (uint8_t)(crc & 0xff);
	p[SECK_UP_DATA + data_len + 1] = (uint8_t)(crc >> 8);
	p[SECK_UP_DATA + data_len + 2] = SECK_END;
	return (int)(SECK_UP_DATA + data_len + 3);
}

/* 组下行帧（平台侧），平台时间用 C 风格 BCD 字段序（非 reverse） */
static int pack_down_cstyle(uint8_t *out, size_t cap,
			    uint16_t frame_num, uint8_t func, uint8_t ctrl,
			    const uint8_t time7[7],
			    const uint8_t *tlv, uint16_t tlv_len)
{
	if (cap < (size_t)(SECK_DOWN_DATA + 2 + tlv_len + 3)) return -1;
	uint8_t *p = out;
	wu16(p + SECK_DOWN_DATA, tlv_len);
	memcpy(p + SECK_DOWN_DATA + 2, tlv, tlv_len);
	uint16_t data_len = (uint16_t)(tlv_len + 2);

	p[0] = SECK_HEAD1;
	p[1] = SECK_HEAD2;
	wu16(p + 2, frame_num);
	p[4] = SECK_VER;
	memcpy(p + 5, time7, 7);
	p[12] = func;
	p[13] = ctrl;
	wu16(p + 14, data_len);

	uint16_t crc = crc16_ccitt_false(p, SECK_DOWN_DATA + data_len);
	p[SECK_DOWN_DATA + data_len] = (uint8_t)(crc & 0xff);
	p[SECK_DOWN_DATA + data_len + 1] = (uint8_t)(crc >> 8);
	p[SECK_DOWN_DATA + data_len + 2] = SECK_END;
	return (int)(SECK_DOWN_DATA + data_len + 3);
}

/* 镜像 baseSeckDataHeadGet 的下行帧校验（要求缓冲以帧头开头） */
static int validate_down_like_c(const uint8_t *buf, uint16_t rlen, char *err, size_t errsz)
{
	if (rlen < 16) {
		snprintf(err, errsz, "too short %u", rlen);
		return -1;
	}
	if (buf[0] != SECK_HEAD1 || buf[1] != SECK_HEAD2) {
		snprintf(err, errsz, "bad head %02X %02X", buf[0], buf[1]);
		return -1;
	}
	uint16_t dataLen = (uint16_t)(buf[SECK_DOWN_LEN] | (buf[SECK_DOWN_LEN + 1] << 8));
	if (dataLen > 512) {
		snprintf(err, errsz, "dataLen too big %u", dataLen);
		return -1;
	}
	uint16_t len = (uint16_t)(SECK_DOWN_LEN + dataLen + 5); /* = 14 + dataLen + 5 = 19+dataLen; full = 16+dataLen+3 */
	/* C: len = SECK_DOWN_LEN + dataLen + 5; end at len-1 */
	if (len > rlen) {
		snprintf(err, errsz, "frame incomplete need %u have %u", len, rlen);
		return -1;
	}
	if (buf[len - 1] != SECK_END) {
		snprintf(err, errsz, "bad end 0x%02X", buf[len - 1]);
		return -1;
	}
	uint16_t crc_calc = crc16_ccitt_false(buf, (size_t)(len - 3));
	uint16_t crc_recv = (uint16_t)(buf[len - 3] | (buf[len - 2] << 8));
	if (crc_calc != crc_recv) {
		snprintf(err, errsz, "crc fail calc=%04X recv=%04X", crc_calc, crc_recv);
		return -1;
	}
	return (int)len;
}

/* 按 C 代码语义遍历下行 TLV（func01 Tag3 固定长度表） */
typedef struct {
	uint8_t id;
	uint8_t vlen; /* 0xFF = 变长/未知 */
} IdLen;

static const IdLen tag3_lens[] = {
	{ 0, 4 }, { 1, 1 }, { 2, 4 }, { 3, 1 }, { 4, 2 }, { 5, 2 },
	{ 6, 32 }, { 7, 32 }, { 8, 4 }, { 9, 2 }, { 10, 1 }, { 11, 1 },
	{ 12, 2 }, { 13, 2 }, { 14, 1 }, { 15, 1 }, { 16, 16 }, { 17, 4 },
	{ 18, 1 }, { 19, 10 }, { 20, 7 }, { 21, 32 }, { 22, 2 }, { 23, 1 },
	{ 24, 1 }, { 25, 7 }, { 26, 10 }, { 27, 4 }, { 28, 1 }, { 29, 1 },
	{ 30, 1 }, { 31, 1 }, { 32, 1 }, { 33, 2 }, { 34, 1 }, { 38, 1 },
	{ 40, 1 }, { 41, 2 },
};

static int tag3_vlen(uint8_t id)
{
	for (size_t i = 0; i < sizeof(tag3_lens) / sizeof(tag3_lens[0]); i++)
		if (tag3_lens[i].id == id) return tag3_lens[i].vlen;
	return -1;
}

/* 镜像 func03：跳过 plainLen(2) + Tag10 + len(2)，按 ID 消费（NULL 无 value） */
static int c_walk_func03(const uint8_t *data, uint16_t data_len, char *msg, size_t msglen)
{
	/* data 指向数据域（含 plainLen） */
	if (data_len < 2) {
		snprintf(msg, msglen, "func03 data too short");
		return -1;
	}
	uint16_t plain = (uint16_t)(data[0] | (data[1] << 8));
	if (2 + plain > data_len) {
		snprintf(msg, msglen, "func03 plainLen overflow %u>%u", plain, data_len);
		return -1;
	}
	const uint8_t *p = data + 2;
	uint16_t left = plain;
	if (left < 1) {
		snprintf(msg, msglen, "func03 empty tlv");
		return -1;
	}
	if (p[0] != 10) {
		snprintf(msg, msglen, "func03 expect Tag10 got %u (C rejects non-10)", p[0]);
		return -1;
	}
	if (left < 3) {
		snprintf(msg, msglen, "func03 tag header short");
		return -1;
	}
	uint16_t tlen = (uint16_t)(p[1] | (p[2] << 8));
	p += 3;
	left = (uint16_t)(left - 3);
	if (tlen > left) {
		snprintf(msg, msglen, "func03 tag len overflow");
		return -1;
	}
	/* C 循环：每个 ID，NULL 类型不读 value；有 value 的按固定硬编码前进 */
	uint16_t pos = 0;
	int n = 0;
	char ids[256];
	ids[0] = 0;
	size_t off = 0;
	while (pos < tlen) {
		uint8_t id = p[pos++];
		n++;
		off += (size_t)snprintf(ids + off, sizeof(ids) - off, "%s%u", off ? "," : "", id);
		switch (id) {
		case 1: case 2: case 3: case 4: case 7: case 8:
		case 10: case 11: case 13: case 14: case 15: case 18:
		case 19: case 20: case 22: case 30: case 31: case 34: case 35:
			/* NULL */
			break;
		case 5: /* 历史 7B — C 按二进制 year u16 + 字段读 */
			if (pos + 7 > tlen) {
				snprintf(msg, msglen, "func03 id5 need 7B");
				return -1;
			}
			pos = (uint16_t)(pos + 7);
			break;
		case 6: case 12: case 16: case 17: case 24:
			if (pos + 1 > tlen) {
				snprintf(msg, msglen, "func03 id%u need 1B", id);
				return -1;
			}
			pos++;
			break;
		case 9: /* 日结 4B */
			if (pos + 4 > tlen) {
				snprintf(msg, msglen, "func03 id9 need 4B");
				return -1;
			}
			pos = (uint16_t)(pos + 4);
			break;
		case 21: /* 音频 4B */
			if (pos + 4 > tlen) {
				snprintf(msg, msglen, "func03 id21 need 4B");
				return -1;
			}
			pos = (uint16_t)(pos + 4);
			break;
		case 23: /* 错误日志 7B */
			if (pos + 7 > tlen) {
				snprintf(msg, msglen, "func03 id23 need 7B");
				return -1;
			}
			pos = (uint16_t)(pos + 7);
			break;
		case 0: /* 指定ID 32B */
			if (pos + 32 > tlen) {
				snprintf(msg, msglen, "func03 id0 need 32B");
				return -1;
			}
			pos = (uint16_t)(pos + 32);
			break;
		default:
			/* C default: 直接 ERR 返回 */
			snprintf(msg, msglen, "func03 unknown id %u -> C returns ERR", id);
			return -2;
		}
	}
	if (pos != tlen) {
		snprintf(msg, msglen, "func03 residual %u of %u ids=[%s]", tlen - pos, tlen, ids);
		return -1;
	}
	snprintf(msg, msglen, "ok n=%d ids=[%s]", n, ids);
	return 0;
}

/* 镜像 func11：Tag93 + 单 ID + 1B value（常见指令） */
static int c_walk_func11(const uint8_t *data, uint16_t data_len, char *msg, size_t msglen)
{
	if (data_len < 2) {
		snprintf(msg, msglen, "func11 short");
		return -1;
	}
	uint16_t plain = (uint16_t)(data[0] | (data[1] << 8));
	if (2 + plain > data_len || plain < 4) {
		snprintf(msg, msglen, "func11 plain bad %u", plain);
		return -1;
	}
	const uint8_t *p = data + 2;
	if (p[0] != 93) {
		snprintf(msg, msglen, "func11 expect Tag93 got %u", p[0]);
		return -1;
	}
	uint16_t tlen = (uint16_t)(p[1] | (p[2] << 8));
	if (tlen < 2) {
		snprintf(msg, msglen, "func11 tag len %u", tlen);
		return -1;
	}
	uint8_t id = p[3];
	uint8_t val = (tlen >= 2) ? p[4] : 0;
	/* 对照 C INIT_MODE: 1..4；开猫 1..3；复位 delay 秒 */
	snprintf(msg, msglen, "ok tag93 id=%u val=%u (C INIT uses 1-4 not 0-3)", id, val);
	return 0;
}

/* 镜像 func01 Tag3：按固定长度推进 */
static int c_walk_func01_tag3(const uint8_t *data, uint16_t data_len, char *msg, size_t msglen)
{
	if (data_len < 2) {
		snprintf(msg, msglen, "func01 short");
		return -1;
	}
	uint16_t plain = (uint16_t)(data[0] | (data[1] << 8));
	if (2 + plain > data_len) {
		snprintf(msg, msglen, "func01 plain overflow");
		return -1;
	}
	const uint8_t *p = data + 2;
	uint16_t left = plain;
	if (left < 3) {
		snprintf(msg, msglen, "func01 no tag");
		return -1;
	}
	uint8_t tag = p[0];
	uint16_t tlen = (uint16_t)(p[1] | (p[2] << 8));
	p += 3;
	left = (uint16_t)(left - 3);
	if (tlen > left) {
		snprintf(msg, msglen, "func01 tlen overflow");
		return -1;
	}
	if (tag != 3 && tag != 30 && tag != 31 && tag != 32 && tag != 33 && tag != 34
	    && tag != 35 && tag != 36 && tag != 37 && tag != 38 && tag != 39) {
		snprintf(msg, msglen, "func01 unexpected tag %u", tag);
		return -1;
	}
	if (tag != 3) {
		snprintf(msg, msglen, "ok tag=%u payload=%u (non-tag3 skip deep walk)", tag, tlen);
		return 0;
	}
	uint16_t pos = 0;
	int n = 0;
	char ids[256];
	ids[0] = 0;
	size_t off = 0;
	while (pos < tlen) {
		uint8_t id = p[pos++];
		int vl = tag3_vlen(id);
		if (vl < 0) {
			snprintf(msg, msglen, "func01 unknown tag3 id %u at %u", id, pos - 1);
			return -1;
		}
		if (pos + (uint16_t)vl > tlen) {
			snprintf(msg, msglen, "func01 id%u need %d have %u", id, vl, tlen - pos);
			return -1;
		}
		pos = (uint16_t)(pos + vl);
		n++;
		off += (size_t)snprintf(ids + off, sizeof(ids) - off, "%s%u", off ? "," : "", id);
	}
	snprintf(msg, msglen, "ok tag3 n=%d ids=[%s]", n, ids);
	return 0;
}

static void print_hex(const char *name, const uint8_t *b, int n)
{
	printf("HEX %s %d:", name, n);
	for (int i = 0; i < n; i++) printf(" %02X", b[i]);
	printf("\n");
}

static int parse_hex_line(const char *s, uint8_t *out, int cap)
{
	int n = 0;
	while (*s) {
		while (*s == ' ' || *s == '\t' || *s == '\n' || *s == '\r') s++;
		if (!*s) break;
		unsigned v;
		if (sscanf(s, "%2x", &v) != 1) break;
		if (n >= cap) return -1;
		out[n++] = (uint8_t)v;
		s += 2;
		if (*s == ' ') s++;
	}
	return n;
}

/* 构造若干 C 风格上行样例 */
static void emit_c_uplink_samples(void)
{
	uint8_t unique[7] = { 0x00, 0x00, 0x12, 0x34, 0x56, 0x78, 0x90 }; /* BCD LE-ish mock */
	uint8_t tlv[512];
	uint16_t tp;
	uint8_t frame[1024];
	int flen;

	/* Sample1: Tag1 基础数据精简 — IMEI + 实时时间 */
	tp = 0;
	tlv[tp++] = 1; /* tag */
	tp += 2;       /* len placeholder */
	tlv[tp++] = 0; /* IMEI */
	memcpy(tlv + tp, "860123456789012", 15);
	tp += 15;
	tlv[tp++] = 6; /* realtime */
	write_bcd_time_c(tlv + tp, 0x2026, 0x07, 0x22, 0x10, 0x30, 0x00);
	tp += 7;
	wu16(tlv + 1, (uint16_t)(tp - 3));
	flen = pack_up(frame, sizeof(frame), 1, 0x02 /* report */, 0x00, unique, -90, 12, 1, 20, tlv, tp);
	print_hex("C_UP_TAG1_BASIC", frame, flen);

	/* Sample2: Tag2 核心 — 流量 u32 + 电压 u16 + 大口径 1+7 */
	tp = 0;
	tlv[tp++] = 2;
	tp += 2;
	tlv[tp++] = 0; /* flow u32 LE */
	wu16(tlv + tp, 0x1234); tp += 2; wu16(tlv + tp, 0); tp += 2; /* actually need u32 */
	/* fix: overwrite last as proper u32 1000 */
	tp -= 4;
	tlv[tp++] = 0xE8; tlv[tp++] = 0x03; tlv[tp++] = 0; tlv[tp++] = 0; /* 1000 */
	tlv[tp++] = 10; /* vol */
	wu16(tlv + tp, 360); tp += 2; /* 3.60V in 0.01V */
	tlv[tp++] = 23; /* large flow 1+7 */
	tlv[tp++] = 0;
	uint64_t f = 1234567ULL;
	memcpy(tlv + tp, &f, 7); tp += 7;
	tlv[tp++] = 29; /* refer qt */
	tlv[tp++] = 0;
	wu16(tlv + 1, (uint16_t)(tp - 3));
	flen = pack_up(frame, sizeof(frame), 2, 0x02, 0x00, unique, -85, 8, 0, 25, tlv, tp);
	print_hex("C_UP_TAG2_CORE", frame, flen);

	/* Sample3: Tag3 终端参数 — 上报频率 + 口径 + IP */
	tp = 0;
	tlv[tp++] = 3;
	tp += 2;
	tlv[tp++] = 9;
	wu16(tlv + tp, 1440); tp += 2;
	tlv[tp++] = 18;
	tlv[tp++] = 5; /* 40mm */
	tlv[tp++] = 6;
	memset(tlv + tp, 0, 32);
	memcpy(tlv + tp, "1.2.3.4,8080", 12);
	tp += 32;
	wu16(tlv + 1, (uint16_t)(tp - 3));
	flen = pack_up(frame, sizeof(frame), 3, 0x83 /* read ack */, 0x00, unique, -70, 15, 0, 28, tlv, tp);
	print_hex("C_UP_TAG3_DEV", frame, flen);

	/* Sample4: Tag93 控制应答 */
	tp = 0;
	tlv[tp++] = 93;
	tp += 2;
	tlv[tp++] = 0; /* open net */
	tlv[tp++] = 1; /* RESULT_OK */
	wu16(tlv + 1, (uint16_t)(tp - 3));
	flen = pack_up(frame, sizeof(frame), 4, 0x91, 0x00, unique, -80, 10, 1, 22, tlv, tp);
	print_hex("C_UP_TAG93_ACK", frame, flen);

	/* Sample5: multi-tag report Tag1+Tag2 */
	tp = 0;
	/* tag1 minimal */
	uint16_t t1 = tp;
	tlv[tp++] = 1; tp += 2;
	tlv[tp++] = 4; /* unique id 7B */
	memcpy(tlv + tp, unique, 7); tp += 7;
	wu16(tlv + t1 + 1, (uint16_t)(tp - t1 - 3));
	/* tag2 minimal */
	uint16_t t2 = tp;
	tlv[tp++] = 2; tp += 2;
	tlv[tp++] = 10; wu16(tlv + tp, 330); tp += 2;
	wu16(tlv + t2 + 1, (uint16_t)(tp - t2 - 3));
	flen = pack_up(frame, sizeof(frame), 5, 0x02, 0x00, unique, -95, 5, 2, 18, tlv, tp);
	print_hex("C_UP_MULTI_T1T2", frame, flen);

	/* CRC vector from app_test_lc.c */
	uint8_t vec[] = { 0xA9, 0x9A, 0x01, 0x00, 0x01, 0x20, 0x20, 0x04, 0x04, 0x00, 0x00, 0x00,
			  0x01, 0x00, 0x08, 0x00, 0x06, 0x00, 0x03, 0x03, 0x00, 0x09, 0x1E, 0x00 };
	uint16_t c = crc16_ccitt_false(vec, sizeof(vec));
	printf("CRC_VECTOR expect=FA78 got=%04X %s\n", c, c == 0xFA78 ? "OK" : "FAIL");
}

/* 读取 stdin 的 WEB_DOWN 行并按 C 语义校验 */
static void consume_web_down_lines(void)
{
	char line[4096];
	uint8_t buf[2048];
	char err[256];
	int total = 0, pass = 0, fail = 0;

	while (fgets(line, sizeof(line), stdin)) {
		if (strncmp(line, "WEB_DOWN ", 9) != 0) continue;
		char name[128];
		const char *hex = NULL;
		/* WEB_DOWN name HEX... */
		if (sscanf(line + 9, "%127s", name) != 1) continue;
		hex = strstr(line + 9, " ");
		if (!hex) continue;
		hex++; /* skip space after name - may still have spaces in hex */
		/* find first hex digit */
		while (*hex && !((*hex >= '0' && *hex <= '9') || (*hex >= 'A' && *hex <= 'F') || (*hex >= 'a' && *hex <= 'f')))
			hex++;
		int n = parse_hex_line(hex, buf, (int)sizeof(buf));
		total++;
		if (n <= 0) {
			printf("C_PARSE FAIL %s bad hex\n", name);
			fail++;
			continue;
		}
		int v = validate_down_like_c(buf, (uint16_t)n, err, sizeof(err));
		if (v < 0) {
			printf("C_PARSE FAIL %s frame: %s\n", name, err);
			fail++;
			continue;
		}
		uint8_t func = buf[12];
		uint8_t ctrl = buf[13];
		uint16_t dlen = (uint16_t)(buf[14] | (buf[15] << 8));
		const uint8_t *data = buf + 16;
		int wr = 0;
		if (ctrl & 0x01) {
			printf("C_PARSE WARN %s encrypted ctrl=0x%02X (mirror skips AES)\n", name, ctrl);
			printf("C_PARSE PASS %s frame_ok func=0x%02X dlen=%u (enc skip tlv)\n", name, func, dlen);
			pass++;
			continue;
		}
		if (func == 0x03)
			wr = c_walk_func03(data, dlen, err, sizeof(err));
		else if (func == 0x11)
			wr = c_walk_func11(data, dlen, err, sizeof(err));
		else if (func == 0x01)
			wr = c_walk_func01_tag3(data, dlen, err, sizeof(err));
		else {
			snprintf(err, sizeof(err), "func 0x%02X not walked", func);
			wr = 0;
		}
		if (wr < 0) {
			printf("C_PARSE FAIL %s tlv: %s\n", name, err);
			fail++;
		} else {
			printf("C_PARSE PASS %s frame_ok func=0x%02X %s\n", name, func, err);
			pass++;
		}
	}
	printf("C_SUMMARY total=%d pass=%d fail=%d\n", total, pass, fail);
}

int main(int argc, char **argv)
{
	if (argc >= 2 && strcmp(argv[1], "gen") == 0) {
		emit_c_uplink_samples();
		return 0;
	}
	if (argc >= 2 && strcmp(argv[1], "check") == 0) {
		consume_web_down_lines();
		return 0;
	}
	/* default: gen then note */
	emit_c_uplink_samples();
	fprintf(stderr, "usage: %s gen | %s check < web_down.txt\n", argv[0], argv[0]);
	return 0;
}
