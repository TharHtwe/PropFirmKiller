"""One-account prop replay.

Same 2-step rules as prop.py. Every trade goes into one account. A blow buys
a new account on the next trade. A pass or a payout stays on that account.

    python prop2.py --file US100_M1_....csv --ids-file queue.txt
"""
from __future__ import annotations

import prop


if __name__ == "__main__":
    prop.main(mode="one")
