# Homebridge Blitzortung

Expose nearby Blitzortung lightning activity as supported sensors in Apple Home.

The plugin subscribes to geohash-filtered strike messages from a configurable MQTT relay,
calculates the distance from a configured location, and ignores strikes outside the detection
radius. It does not require Home Assistant.

## HomeKit representation

Apple Home and the HomeKit Accessory Protocol do not define a lightning sensor service. This
plugin therefore exposes two standard sensors:

- **Lightning Strike** is a motion sensor that activates briefly for every nearby strike. Use it
  for Apple Home notifications and immediate automations.
- **Storm Nearby** is an occupancy sensor that remains active until no nearby strikes have been
  observed for the configured clear period.

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
  "topicPrefix": "blitzortung/1.1"
}
```

Run this plugin as a Homebridge child bridge so feed failures or upgrades do not affect unrelated
accessories.

## Development

```sh
npm install
npm run check
npm pack --dry-run
```

## Attribution

Lightning data is provided by [Blitzortung.org](https://www.blitzortung.org/), a community
collaborative lightning location network. This plugin is not affiliated with or endorsed by
Blitzortung.org.

## License

MIT
