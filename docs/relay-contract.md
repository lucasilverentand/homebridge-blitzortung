# Relay contract and verification boundaries

The plugin consumes a configured, authorized MQTT relay. Its original contract guarantees only
numeric `lat` and `lon` on geohash topics below `blitzortung/1.1`. The repository contains no
production relay address or upstream status schema; its smoke fixture uses a local test broker.

The community Home Assistant consumer at commit
[`943b67d`](https://github.com/mrk-its/homeassistant-blitzortung/blob/943b67d31fd6a7394cec26cc2d19efc79e9bb246/custom_components/blitzortung/geo_location.py#L75-L94)
converts strike `time` from Unix nanoseconds to seconds. This establishes the optional time
format supported here. A payload's strike `status` is not an upstream health heartbeat. No
assumption is made that a custom relay supplies timestamps, stable IDs, heartbeats or status
messages. A custom stable `id`, when present, is used only for bounded replay protection.

MQTT SUBACK establishes subscription connectivity. MQTT keepalive detects a dead broker
connection; it cannot detect a relay whose upstream has stopped while the broker remains live.
The sensors remain observations with expiry windows, and the map explicitly reports upstream
freshness as unverified. A quiet interval does not become a reported upstream outage. Even a
recent timestamped strike is evidence about that event, not a continuous relay health guarantee.
Verified upstream health would require a separately documented, implemented and tested relay
status contract. This release does not claim that acceptance.

Regression coverage checks retained data, nanosecond timestamp age and clock skew, replay
identity across transport reconnects, coordinate-only compatibility, subscription rejection and
bounded retry, and cancellation of retry timers and late callbacks. These checks use controlled
messages and broker events. They do not establish live relay freshness, household notifications
or physical device acceptance. Geographic and camera transport changes are outside this repair.

Delivery is tracked in [HL-27](https://linear.app/seventwo/issue/HL-27/repair-and-release-homebridge-blitzortung-feed-reliability).
