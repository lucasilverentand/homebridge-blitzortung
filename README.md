# Homebridge Blitzortung

Expose nearby Blitzortung lightning activity in Apple Home.

The plugin subscribes to geohash-filtered strike messages from a configurable MQTT relay,
calculates the distance from a configured location, and ignores strikes outside the detection
radius. It can also expose an optional HomeKit camera containing a live map of the configured
area and recent lightning. It does not require Home Assistant.

## HomeKit representation

Apple Home and the HomeKit Accessory Protocol do not define a lightning sensor service. This
plugin therefore exposes two standard sensors:

- **Lightning Strike** is a motion sensor that activates briefly for every nearby strike. Use it
  for Apple Home notifications and immediate automations.
- **Storm Nearby** is an occupancy sensor that remains active until no nearby strikes have been
  observed for the configured clear period.
- **Lightning Map** is an optional camera. Its snapshot and live video show the detection radius,
  feed state, and recent strikes, with newer strikes drawn more prominently.

Distance and strike count are intentionally not encoded into unrelated HomeKit characteristics.
The exact distance is available in the Homebridge log.

## Data source

This plugin consumes an MQTT relay whose topics follow the geohash layout used by the community
Blitzortung integration:

```text
blitzortung/1.1/<geohash characters separated by slashes>/...
```

Each payload must be JSON containing numeric `lat` and `lon` properties.

Blitzortung's data usage policy requires third-party applications to serve their clients through
their own intermediary service. This package deliberately does not default to the public relay
operated for another integration and does not connect directly to Blitzortung websocket servers.
Configure a relay you are authorized to use.

## Requirements

- Homebridge 1.8 or 2.x
- Node.js 22 or 24
- An authorized Blitzortung-compatible MQTT relay

## Installation

Install through Homebridge UI by searching for **Homebridge Blitzortung**, or install from npm:

```sh
npm install -g homebridge-blitzortung
```

## Configuration

Store an MQTT password in the environment used to launch Homebridge:

```sh
export BLITZORTUNG_MQTT_PASSWORD='replace-me'
```

Then add the platform in Homebridge:

```json
{
  "platform": "Blitzortung",
  "name": "Lightning",
  "latitude": 52.3676,
  "longitude": 4.9041,
  "radiusKm": 25,
  "strikeAlertSeconds": 30,
  "stormClearMinutes": 30,
  "mqttHost": "mqtt.example.net",
  "mqttPort": 8883,
  "mqttTls": true,
  "mqttUsername": "homebridge",
  "mqttPasswordEnvironmentVariable": "BLITZORTUNG_MQTT_PASSWORD",
  "topicPrefix": "blitzortung/1.1",
  "camera": {
    "enabled": true,
    "name": "Lightning Map",
    "zoom": 9,
    "strikeHistoryMinutes": 60,
    "refreshSeconds": 10
  }
}
```

Run this plugin as a Homebridge child bridge so feed failures or upgrades do not affect unrelated
accessories.

### Map camera

The map camera uses the platform's `latitude`, `longitude`, and `radiusKm`; it does not need a
second location. The plugin bundles FFmpeg and renders H.264 video for HomeKit, so no system
FFmpeg installation is normally required. Set `camera.ffmpegPath` only when you need to override
the bundled binary.

Homebridge publishes the map as a standalone external camera so HomeKit can reach its snapshot
and video handlers directly. After enabling the camera and restarting the plugin, add the
`Lightning Map` accessory separately in Apple Home with the setup code shown in the Homebridge
log. Upgrading from 0.2.0 removes the old unresponsive bridged camera automatically.

OpenStreetMap is the default tile provider. The plugin identifies itself in tile requests, renders
the required attribution on the camera image, and keeps downloaded tiles for at least seven days.
If you configure a different `camera.tileUrlTemplate`, also set the attribution and user agent
required by that provider. Avoid using a tile service that prohibits server-side rendering.

Camera settings:

- `enabled`: add or remove the map camera accessory; defaults to `false`.
- `zoom`: map zoom from 1–18; defaults to `9`.
- `strikeHistoryMinutes`: how long strikes remain on the map; defaults to `60`.
- `refreshSeconds`: minimum time between map renders; defaults to `10`.
- `tileUrlTemplate`: tile URL containing `{z}`, `{x}`, and `{y}`.
- `tileAttribution`: attribution drawn on every frame.
- `tileUserAgent`: identification sent with tile requests.
- `tileCacheDays`: disk-cache lifetime; the minimum is seven days.
- `ffmpegPath`: optional custom FFmpeg executable.

## Development

```sh
npm install
npm run check
npm pack --dry-run
```

Releases are managed by semantic-release. Conventional `feat:` and `fix:` commits merged to
`main` determine the next version, create the GitHub release, and publish npm through OIDC.

## Attribution

Lightning data is provided by [Blitzortung.org](https://www.blitzortung.org/), a community
collaborative lightning location network. This plugin is not affiliated with or endorsed by
Blitzortung.org.

## License

MIT
