from .amazon_in import AmazonIn
from .flipkart import Flipkart

# platform key (as in config/platforms.yaml) -> adapter class
REGISTRY = {
    AmazonIn.key: AmazonIn,
    Flipkart.key: Flipkart,
}
