"""Constants for the Netroni XP-Master integration."""

DOMAIN = "netroni"
DEFAULT_PORT = 8765
MANUFACTURER = "Visiolite"
API_VERSION = 3  # Netroni service API this integration speaks
# The Netroni service's API token, mounted into the Home Assistant container on an XP-Master
TOKEN_FILE = "/run/netroni/api-token"

PORTS_PER_MINI = 8  # Port 1..8, each with an A and a B output

KELVIN_WARM = 2200
KELVIN_COOL = 5000

SIGNAL_HUBS_CHANGED = "netroni_hubs_changed"  # an XP-Master was set up or unloaded (panel)

SERVICE_PAIR = "pair_port"
SERVICE_UNPAIR = "unpair_port"
ATTR_PORT = "port"
