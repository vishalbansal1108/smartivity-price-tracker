from .amazon_in import AmazonIn
from .blinkit import Blinkit
from .firstcry import FirstCry
from .flipkart import Flipkart
from .myntra import Myntra

# platform key (as in config/platforms.yaml) -> adapter class
REGISTRY = {
    AmazonIn.key: AmazonIn,
    Flipkart.key: Flipkart,
    Myntra.key: Myntra,
    FirstCry.key: FirstCry,
    Blinkit.key: Blinkit,
}
