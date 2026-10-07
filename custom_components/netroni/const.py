"""Constants for the Netroni XP-Master integration."""

DOMAIN = "netroni"
DEFAULT_PORT = 8765
MANUFACTURER = "Visiolite"
API_VERSION = 2  # Netroni service API this integration speaks

CHANNEL_PAIRS = 8  # Ch1..Ch8, each with an A and a B channel

KELVIN_WARM = 2700
KELVIN_COOL = 6500

SERVICE_PAIR = "pair_channel"
SERVICE_UNPAIR = "unpair_channel"
ATTR_CHANNEL = "channel"
