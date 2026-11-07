---
id: B-0001
title: Community vault with a guardian
status: new
---
A community group keeps its shared funds on Cardano and wants a free tool to manage them together.

Members create an m-of-n multi-sig vault, propose a payment from it, collect the members' signatures and submit the
payment. A guardian must co-sign every payment: without the guardian's signature nothing can be spent from the vault,
even with m member signatures. Losing any single device, the guardian's included, must never lose the funds.

Keys never leave the members' devices, and no server holds keys or can sign. Members and the guardian sign with
Ledger hardware wallets. Everything runs on preprod first; mainnet comes later.

Acceptance criteria:

- On preprod, a payment with m member signatures but without the guardian's is rejected.
- On preprod, a payment with m member signatures and the guardian's goes through.
- On preprod, losing any one device does not lose the funds.
