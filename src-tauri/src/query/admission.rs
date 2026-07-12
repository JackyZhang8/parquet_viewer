use std::sync::Arc;

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

impl Drop for AdmissionPermit {
    fn drop(&mut self) {
        let mut count = self.admission.count.lock();
        *count -= 1;
        self.admission.changed.notify_all();
    }
}
