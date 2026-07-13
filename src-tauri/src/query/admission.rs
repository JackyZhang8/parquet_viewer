use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use parking_lot::{Condvar, Mutex};

const MAX_OUTSTANDING_QUERIES: usize = 4;

#[derive(Default)]
pub(super) struct Admission {
    count: Mutex<usize>,
    changed: Condvar,
}

impl Admission {
    pub(super) fn try_acquire(self: &Arc<Self>) -> Option<Arc<AdmissionPermit>> {
        let mut count = self.count.lock();
        if *count >= MAX_OUTSTANDING_QUERIES {
            return None;
        }
        *count += 1;
        self.changed.notify_all();
        Some(Arc::new(AdmissionPermit {
            admission: self.clone(),
        }))
    }

    #[cfg(test)]
    pub(super) fn count(&self) -> usize {
        *self.count.lock()
    }

    #[cfg(test)]
    pub(super) fn wait_for(&self, expected: usize) {
        let mut count = self.count.lock();
        while *count != expected {
            self.changed.wait(&mut count);
        }
    }
}

pub(super) struct AdmissionPermit {
    admission: Arc<Admission>,
}

pub(super) struct ExecutionGate {
    running: Mutex<usize>,
    limit: AtomicUsize,
    changed: Condvar,
}

impl ExecutionGate {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            running: Mutex::new(0),
            limit: AtomicUsize::new(limit.clamp(1, 4)),
            changed: Condvar::new(),
        }
    }

    pub(super) fn set_limit(&self, limit: usize) {
        self.limit.store(limit.clamp(1, 4), Ordering::Release);
        self.changed.notify_all();
    }

    pub(super) fn limit(&self) -> usize {
        self.limit.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(super) fn try_acquire(
        self: &Arc<Self>,
        cancelled: &AtomicBool,
    ) -> Option<Arc<ExecutionPermit>> {
        if cancelled.load(Ordering::Acquire) {
            return None;
        }
        let mut running = self.running.lock();
        if *running >= self.limit() {
            return None;
        }
        *running += 1;
        Some(Arc::new(ExecutionPermit { gate: self.clone() }))
    }

    pub(super) fn acquire(
        self: &Arc<Self>,
        cancelled: &AtomicBool,
    ) -> Option<Arc<ExecutionPermit>> {
        let mut running = self.running.lock();
        loop {
            if cancelled.load(Ordering::Acquire) {
                return None;
            }
            if *running < self.limit() {
                *running += 1;
                return Some(Arc::new(ExecutionPermit { gate: self.clone() }));
            }
            self.changed
                .wait_for(&mut running, Duration::from_millis(50));
        }
    }
}

pub(super) struct ExecutionPermit {
    gate: Arc<ExecutionGate>,
}

impl Drop for ExecutionPermit {
    fn drop(&mut self) {
        let mut running = self.gate.running.lock();
        *running -= 1;
        self.gate.changed.notify_all();
    }
}

impl Drop for AdmissionPermit {
    fn drop(&mut self) {
        let mut count = self.admission.count.lock();
        *count -= 1;
        self.admission.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    use super::ExecutionGate;

    #[test]
    fn execution_gate_honors_dynamic_concurrency_limits() {
        let gate = Arc::new(ExecutionGate::new(2));
        let cancelled = AtomicBool::new(false);
        let first = gate.try_acquire(&cancelled).unwrap();
        let second = gate.try_acquire(&cancelled).unwrap();
        assert!(gate.try_acquire(&cancelled).is_none());
        gate.set_limit(1);
        drop(first);
        assert!(gate.try_acquire(&cancelled).is_none());
        drop(second);
        assert!(gate.try_acquire(&cancelled).is_some());
        gate.set_limit(4);
        assert_eq!(gate.limit(), 4);
    }
}
