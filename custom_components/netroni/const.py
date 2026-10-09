"""Constants for the Netroni XP-Master integration."""

DOMAIN = "netroni"
DEFAULT_PORT = 8765
MANUFACTURER = "Visiolite"
API_VERSION = 3  # Netroni service API this integration speaks

PORTS_PER_MINI = 8  # Port 1..8, each with an A and a B output

KELVIN_WARM = 2700
KELVIN_COOL = 6500

SIGNAL_HUBS_CHANGED = "netroni_hubs_changed"  # an XP-Master was set up or unloaded (panel)

SERVICE_PAIR = "pair_port"
SERVICE_UNPAIR = "unpair_port"
ATTR_PORT = "port"
