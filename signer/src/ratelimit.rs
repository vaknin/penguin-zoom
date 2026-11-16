//! In-memory per-client token bucket. Keys are IPs (IPv6 folded to its /64 so
//! one host can't rotate addresses); they are never logged.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct RateLimiter {
    per_hour: f64,
    burst: f64,
    buckets: Mutex<HashMap<IpAddr, Bucket>>,
}

#[derive(Clone, Copy)]
struct Bucket {
    tokens: f64,
    last: Instant,
}

/// Fold an address to the unit we limit on: IPv4 as is (and IPv4-mapped
/// IPv6 as IPv4), other IPv6 to its /64 prefix.
pub fn limit_key(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return IpAddr::V4(v4);
            }
            let s = v6.segments();
            IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
        }
    }
}

impl RateLimiter {
    pub fn new(per_hour: u32, burst: u32) -> Self {
        Self {
            per_hour: f64::from(per_hour.max(1)),
            burst: f64::from(burst.max(1)),
            buckets: Mutex::new(HashMap::new()),
        }
    }

    fn refill_per_sec(&self) -> f64 {
        self.per_hour / 3600.0
    }

    /// Take one token. `Err(wait)` says how long until the next one.
    pub fn check(&self, ip: IpAddr, now: Instant) -> Result<(), Duration> {
        let rate = self.refill_per_sec();
        let mut map = self.buckets.lock().unwrap_or_else(|p| p.into_inner());
        let b = map.entry(limit_key(ip)).or_insert(Bucket {
            tokens: self.burst,
            last: now,
        });
        let elapsed = now.saturating_duration_since(b.last).as_secs_f64();
        b.tokens = (b.tokens + elapsed * rate).min(self.burst);
        b.last = now;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            Ok(())
        } else {
            Err(Duration::from_secs_f64(((1.0 - b.tokens) / rate).ceil()))
        }
    }

    /// Drop buckets that would be full by now (they equal a fresh one).
    pub fn prune(&self, now: Instant) {
        let rate = self.refill_per_sec();
        let burst = self.burst;
        let mut map = self.buckets.lock().unwrap_or_else(|p| p.into_inner());
        map.retain(|_, b| {
            b.tokens + now.saturating_duration_since(b.last).as_secs_f64() * rate < burst
        });
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.buckets.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn burst_then_refill() {
        let rl = RateLimiter::new(60, 10); // one token per minute
        let t0 = Instant::now();
        for _ in 0..10 {
            assert!(rl.check(ip("192.0.2.1"), t0).is_ok());
        }
        assert_eq!(
            rl.check(ip("192.0.2.1"), t0).unwrap_err(),
            Duration::from_secs(60)
        );
        // Another client is unaffected.
        assert!(rl.check(ip("192.0.2.2"), t0).is_ok());
        // 59 s later still nothing; after 60 s exactly one more.
        assert!(
            rl.check(ip("192.0.2.1"), t0 + Duration::from_secs(59))
                .is_err()
        );
        assert!(
            rl.check(ip("192.0.2.1"), t0 + Duration::from_secs(61))
                .is_ok()
        );
        assert!(
            rl.check(ip("192.0.2.1"), t0 + Duration::from_secs(61))
                .is_err()
        );
        // Two hours later the bucket is full again, but never above burst.
        let later = t0 + Duration::from_secs(7200);
        for _ in 0..10 {
            assert!(rl.check(ip("192.0.2.1"), later).is_ok());
        }
        assert!(rl.check(ip("192.0.2.1"), later).is_err());
    }

    #[test]
    fn ipv6_shares_a_slash_64() {
        let rl = RateLimiter::new(60, 2);
        let t0 = Instant::now();
        assert!(rl.check(ip("2001:db8:1:2::1"), t0).is_ok());
        assert!(rl.check(ip("2001:db8:1:2:ffff::9"), t0).is_ok());
        assert!(rl.check(ip("2001:db8:1:2::abcd"), t0).is_err());
        assert!(rl.check(ip("2001:db8:1:3::1"), t0).is_ok());
        assert_eq!(limit_key(ip("::ffff:192.0.2.7")), ip("192.0.2.7"));
    }

    #[test]
    fn prune_drops_only_full_buckets() {
        let rl = RateLimiter::new(60, 10);
        let t0 = Instant::now();
        rl.check(ip("192.0.2.1"), t0).unwrap();
        rl.check(ip("192.0.2.2"), t0 + Duration::from_secs(590))
            .unwrap();
        rl.prune(t0 + Duration::from_secs(601));
        assert_eq!(rl.len(), 1);
    }
}
