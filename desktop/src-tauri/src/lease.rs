// 公共 owner / lease / generation / release 契约(T1)：串口、MCP 与后续 RTT/BLE 后端共用的生命周期基元。
//
// 词汇与映射：
// - owner：资源的唯一归属。物理资源(串口路径、探针、BLE 桥)的 owner 是「窗口标签 + 文档代次」——
//   窗口标签定归属窗口，页面每次加载(serial_release_owned)/销毁/升级收尾推进该 owner 的代次，
//   即文档代次；MCP 请求租约的 owner 是「窗口标签 + bridgeEpoch」，语义同源。
// - generation：代次。owner 的连接代次随每次 release 推进，旧代次的在飞调用不能登记新资源、
//   也不能继续操作；MCP 侧对应 pending 里的 (bridgeEpoch, epoch) 校验。
// - release：刷新 / 窗口销毁 / 停服 / 换令牌 / 升级时统一回收——先推进代次置屏障(invalidate)，
//   再收走该 owner 的资源并等待在飞调用排空。两层语义要分清：
//   物理释放(关串口句柄、停读线程)只动本 owner 的资源，不误关别窗；
//   请求租约释放(MCP 在飞请求判终态)不释放窗口的 UI 连接。
// - 设备租约(Claims)：同一物理资源同时只有一个 owner，「打开途中」也算占用——
//   不等操作系统独占报错，跨窗口 / 并发 open 在进程内确定裁决，可离线测试。
//
// 锁序约定：调用方先拿自己的资源表锁(serial 的 handles)，再碰 lifecycle 内部锁；
// invalidate 只在这把资源表锁的保护下做，登记方在同一把锁里查代次就能与释放线性化。
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

#[derive(Default)]
struct OwnerInner {
    generation: u64,
    active: usize,
    releasing: usize,
}

// 单 owner 生命周期屏障：记录该 owner 的当前代次、在飞操作数与进行中的释放数。
#[derive(Default)]
pub struct OwnerLifecycle {
    inner: Mutex<OwnerInner>,
    drained: Condvar,
}

// 一次在飞调用的租约：持有期间计入 owner 的活跃数(释放要等它归还)，generation 记录取得时的代次。
pub struct OwnerOperation {
    owner: Arc<OwnerLifecycle>,
    pub generation: u64,
}

impl OwnerLifecycle {
    // begin(None)：开新资源前的屏障；begin(Some(g))：对已登记句柄的操作按登记代次校验。
    // releasing != 0(回收中)或代次不符即拒绝。
    pub fn begin(self: &Arc<Self>, expected: Option<u64>) -> Result<OwnerOperation, String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.releasing != 0 || expected.is_some_and(|g| g != inner.generation) {
            return Err("资源会话已回收或正在回收".into());
        }
        inner.active += 1;
        Ok(OwnerOperation {
            owner: self.clone(),
            generation: inner.generation,
        })
    }

    // 推进代次并置释放屏障；返回新代次。只在调用方资源表锁的保护下调用(锁序见模块注释)，
    // 否则登记方无法在「查代次 → 登记」之间挡住释放插队。
    pub fn invalidate(&self) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        inner.generation += 1;
        inner.releasing += 1;
        inner.generation
    }

    // 等全部在飞 operation 归还；deadline 到点返回 false(旧代次操作仍不能登记，只是不再等)。
    pub fn wait_drained(&self, deadline: Instant) -> bool {
        let inner = self.inner.lock().unwrap();
        let (inner, _) = self
            .drained
            .wait_timeout_while(inner, deadline.saturating_duration_since(Instant::now()), |s| s.active != 0)
            .unwrap();
        inner.active == 0
    }

    #[cfg(test)]
    fn stats(&self) -> (u64, usize, usize) {
        let inner = self.inner.lock().unwrap();
        (inner.generation, inner.active, inner.releasing)
    }
}

impl OwnerOperation {
    // owner 仍停在取得本操作时那一代且不在释放中。
    // 登记新资源时在调用方的资源表锁里调它：invalidate 也只在那把锁里做，查到 true 到登记之间不会被释放插队。
    pub fn is_current(&self) -> bool {
        let inner = self.owner.inner.lock().unwrap();
        inner.generation == self.generation && inner.releasing == 0
    }
}

impl Drop for OwnerOperation {
    fn drop(&mut self) {
        let mut inner = self.owner.inner.lock().unwrap();
        inner.active -= 1;
        self.owner.drained.notify_all();
    }
}

// 释放屏障：构造前该 owner 已 invalidate(代次 +1、releasing +1)，payload 是收回的句柄，由后端逐个关停后释放。
// releasing 必须减回，哪怕收尾没跑(后台任务在退出时被丢弃)或中途 panic：否则这个 owner 之后一直开不了资源。
pub struct OwnerRelease<P> {
    owner: Arc<OwnerLifecycle>,
    // 收回的资源句柄，各后端自定义(serial 是 Vec<Arc<Handle>>)
    pub payload: P,
}

impl<P> OwnerRelease<P> {
    pub fn new(owner: Arc<OwnerLifecycle>, payload: P) -> Self {
        OwnerRelease { owner, payload }
    }

    pub fn wait_drained(&self, deadline: Instant) -> bool {
        self.owner.wait_drained(deadline)
    }
}

impl<P> Drop for OwnerRelease<P> {
    fn drop(&mut self) {
        let mut inner = match self.owner.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        inner.releasing -= 1;
        self.owner.drained.notify_all();
    }
}

// owner → lifecycle 登记表：每个窗口标签一份；页面刷新不重建，代次推进即与旧文档隔离。
#[derive(Default)]
pub struct OwnerSet {
    map: Mutex<HashMap<String, Arc<OwnerLifecycle>>>,
}

impl OwnerSet {
    pub fn owner(&self, label: &str) -> Arc<OwnerLifecycle> {
        self.map.lock().unwrap().entry(label.to_string()).or_default().clone()
    }
}

// ---------- 设备级租约 ----------

// 资源键归一化：Windows 设备路径/口名不区分大小写(COM3 == com3)，统一大写；
// POSIX 路径区分大小写，原样保留。各后端传入自己的资源标识(串口路径、探针序号、桥 id)。
pub fn resource_key(path: &str) -> String {
    let p = path.trim();
    if cfg!(windows) {
        p.to_uppercase()
    } else {
        p.to_string()
    }
}

// 占用被拒的两类原因，消息文案由各后端按资源类型给出。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimDenied {
    // 同一 owner 已有占用(同窗口另一路、重入打开、或旧代次凭据未归还的残留)
    SameOwner,
    // 另一 owner 占用中
    OtherOwner,
}

#[derive(Clone, Debug)]
struct Claim {
    owner: String,
    generation: u64,
}

// 物理资源占用表：已登记句柄与打开途中的 pending 各占一行，直到 ClaimGuard 释放。
#[derive(Clone, Debug, Default)]
pub struct Claims {
    map: Arc<Mutex<HashMap<String, Claim>>>,
}

// 占用凭据：存活即占用，Drop 时按(owner, generation)条件归还——记录已不属自己就让它留着。
// acquire 已禁止在凭据未归还时重取，这条件检查只是防卫，正常路径不会遇到占用被顶替。
#[derive(Debug)]
pub struct ClaimGuard {
    claims: Claims,
    key: String,
    owner: String,
    generation: u64,
}

impl Claims {
    // 占用一个资源：只要有凭据没归还就拒绝——同 owner 报 SameOwner、别的 owner 报 OtherOwner，不分代次。
    // 旧代次晚到新代次占用之后、或新代次早到旧代次归还之前，两个方向都一样拒：
    // 若允许新代次顶替，被顶掉的那方随后归还凭据时会误删新占用，还存活的句柄就失去保护、能被别窗再获取。
    // 同 owner 旧代次的残留(释放超时、被废弃的打开)必须等它的凭据归还才可重取。
    pub fn acquire(&self, key: &str, owner: &str, generation: u64) -> Result<ClaimGuard, ClaimDenied> {
        let mut map = self.map.lock().unwrap();
        if let Some(c) = map.get(key) {
            return Err(if c.owner == owner {
                ClaimDenied::SameOwner
            } else {
                ClaimDenied::OtherOwner
            });
        }
        map.insert(
            key.to_string(),
            Claim {
                owner: owner.to_string(),
                generation,
            },
        );
        Ok(ClaimGuard {
            claims: self.clone(),
            key: key.to_string(),
            owner: owner.to_string(),
            generation,
        })
    }

    // 条件释放：占用记录仍是这个 owner+代次才删，不碰已换手的记录(防卫，acquire 已禁止顶替)。
    pub fn release(&self, key: &str, owner: &str, generation: u64) {
        let mut map = self.map.lock().unwrap();
        if map.get(key).is_some_and(|c| c.owner == owner && c.generation == generation) {
            map.remove(key);
        }
    }

    pub fn contains(&self, key: &str) -> bool {
        self.map.lock().unwrap().contains_key(key)
    }

    // 当前被占用的资源键(含打开途中)：供列口标「已打开」
    pub fn keys(&self) -> Vec<String> {
        self.map.lock().unwrap().keys().cloned().collect()
    }

    #[cfg(test)]
    fn holder(&self, key: &str) -> Option<(String, u64)> {
        self.map.lock().unwrap().get(key).map(|c| (c.owner.clone(), c.generation))
    }
}

impl Drop for ClaimGuard {
    fn drop(&mut self) {
        self.claims.release(&self.key, &self.owner, self.generation);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn release_invalidates_pending_and_rejects_stale_operation() {
        let owners = OwnerSet::default();
        let owner = owners.owner("w");
        let opening = owner.begin(None).unwrap();
        let old_generation = opening.generation;
        owner.invalidate();
        let release = OwnerRelease::new(owner.clone(), ());
        assert_ne!(owner.stats().0, old_generation);
        assert!(!opening.is_current());
        assert!(owner.begin(None).is_err());
        drop(opening);
        assert!(release.wait_drained(Instant::now() + Duration::from_secs(1)));
        drop(release);
        // 旧代次不能登记/操作，新租约可取得
        assert!(owner.begin(Some(old_generation)).is_err());
        assert!(owner.begin(None).is_ok());
    }

    #[test]
    fn drain_waits_until_all_operations_drop() {
        let owners = OwnerSet::default();
        let owner = owners.owner("w");
        let opening = owner.begin(None).unwrap();
        let writing = owner.begin(Some(opening.generation)).unwrap();
        owner.invalidate();
        let release = OwnerRelease::new(owner.clone(), ());
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            entered_tx.send(()).unwrap();
            let drained = release.wait_drained(Instant::now() + Duration::from_secs(5));
            done_tx.send(drained).unwrap();
            drop(release);
        });
        entered_rx.recv().unwrap();
        drop(opening);
        assert_eq!(owner.stats().1, 1);
        assert!(matches!(done_rx.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)));
        drop(writing);
        assert!(done_rx.recv_timeout(Duration::from_secs(1)).unwrap());
        worker.join().unwrap();
        assert_eq!(owner.stats().1, 0);
    }

    #[test]
    fn wait_drained_is_bounded_and_can_finish_later() {
        let owner = Arc::new(OwnerLifecycle::default());
        let operation = owner.begin(None).unwrap();
        assert!(!owner.wait_drained(Instant::now()));
        drop(operation);
        assert!(owner.wait_drained(Instant::now()));
    }

    #[test]
    fn overlapping_releases_do_not_reopen_barrier_early() {
        let owners = OwnerSet::default();
        let owner = owners.owner("w");
        owner.invalidate();
        let first = OwnerRelease::new(owner.clone(), ());
        owner.invalidate();
        let second = OwnerRelease::new(owner.clone(), ());
        drop(first);
        assert!(owner.begin(None).is_err());
        drop(second);
        assert!(owner.begin(None).is_ok());
        assert_eq!(owner.stats().0, 2);
    }

    #[test]
    fn dropped_release_without_drain_still_reopens_barrier() {
        let owners = OwnerSet::default();
        let owner = owners.owner("w");
        owner.invalidate();
        drop(OwnerRelease::new(owner.clone(), ()));
        assert_eq!(owner.stats().2, 0);
        assert!(owner.begin(None).is_ok());
    }

    #[test]
    fn release_is_isolated_by_owner_and_generation_survives_reuse() {
        let owners = OwnerSet::default();
        let first = owners.owner("first");
        let second = owners.owner("second");
        let initial = first.begin(None).unwrap().generation;
        first.invalidate();
        drop(OwnerRelease::new(first.clone(), ()));
        assert!(second.begin(Some(0)).is_ok());
        assert!(Arc::ptr_eq(&first, &owners.owner("first")));
        assert!(first.begin(Some(initial)).is_err());
    }

    #[test]
    fn claim_blocks_other_owner_and_same_owner_reentry() {
        let claims = Claims::default();
        let g1 = claims.acquire("K", "win-a", 1).unwrap();
        assert_eq!(claims.acquire("K", "win-a", 1).unwrap_err(), ClaimDenied::SameOwner);
        assert_eq!(claims.acquire("K", "win-b", 1).unwrap_err(), ClaimDenied::OtherOwner);
        drop(g1);
        assert!(claims.acquire("K", "win-b", 1).is_ok());
    }

    // 复现评审的竞态：凭据未归还期间两个方向都禁止顶替。
    #[test]
    fn held_claim_denies_displacement_in_both_generation_directions() {
        let claims = Claims::default();
        // 新→旧方向：旧代次 pending 还没归还，新代次想顶替——拒
        let stale = claims.acquire("K", "win-a", 1).unwrap();
        assert_eq!(
            claims.acquire("K", "win-a", 2).unwrap_err(),
            ClaimDenied::SameOwner
        );
        drop(stale);
        // 实际凭据归还后才可重取
        let current = claims.acquire("K", "win-a", 2).unwrap();
        assert_eq!(claims.holder("K"), Some(("win-a".into(), 2)));
        // 旧→新方向：新占用还活着，迟到的旧代次请求晚到——同样拒。
        // 被拒的请求拿不到凭据，随后登记屏障失败的收尾没有东西可删，移不走当前占用
        assert_eq!(
            claims.acquire("K", "win-a", 1).unwrap_err(),
            ClaimDenied::SameOwner
        );
        assert_eq!(claims.holder("K"), Some(("win-a".into(), 2)));
        drop(current);
        assert!(claims.holder("K").is_none());
    }

    #[test]
    fn stale_claim_cannot_be_displaced_by_other_owner() {
        let claims = Claims::default();
        let _stale = claims.acquire("K", "win-a", 1).unwrap();
        // 别的窗口没有「替旧代次收尾」的权力
        assert_eq!(claims.acquire("K", "win-b", 3).unwrap_err(), ClaimDenied::OtherOwner);
    }

    #[test]
    fn concurrent_pending_acquires_keep_single_owner() {
        let claims = Claims::default();
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let mut workers = Vec::new();
        for i in 0..8 {
            let claims = claims.clone();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                let owner = format!("win-{}", i % 2);
                barrier.wait();
                // 凭据带回来保住占用，否则返回值处 Drop 会让下一个立刻得手
                claims.acquire("K", &owner, 0).ok()
            }));
        }
        let wins: Vec<Option<ClaimGuard>> = workers.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(wins.iter().filter(|w| w.is_some()).count(), 1);
    }

    #[test]
    fn resource_key_normalizes_case_only_on_windows() {
        let key = resource_key(" COM3 ");
        if cfg!(windows) {
            assert_eq!(key, "COM3");
        } else {
            assert_eq!(key, "COM3");
        }
        let mixed = resource_key("Com3");
        if cfg!(windows) {
            assert_eq!(mixed, "COM3");
        } else {
            assert_eq!(mixed, "Com3");
        }
    }
}
