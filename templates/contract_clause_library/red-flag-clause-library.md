# Red Flag Clause Library

Reference library for the contract review agent. Each entry is a pattern to detect, why it
matters, and a fallback ask. This is the part of the swarm that's actual IP — the agent's
prompt should be seeded from this list, and it should grow every time a new contract surfaces
a pattern not yet covered here.

## Indemnification

Pattern: One-sided indemnification — the small business agrees to indemnify the other
party for "any and all claims," with no cap, no mutuality, and no carve-out for the other
party's own negligence.
Why it matters: Uncapped indemnification can expose the business to liability far beyond
the contract's value, including for problems it didn't cause.
Fallback ask: Mutual indemnification, capped at the fees paid under the agreement, carving
out claims arising from the other party's gross negligence or willful misconduct.

## Liability

Pattern: No limitation-of-liability clause at all, or one that only protects the other
party.
Why it matters: Without a cap, a single mistake could create liability many multiples of
what the engagement was worth.
Fallback ask: Mutual cap on liability, typically fees paid in the prior 12 months, with
standard carve-outs (IP infringement, confidentiality breach, gross negligence).

## Intellectual property

Pattern: "All work product, including drafts, concepts, and unused ideas" assigned to the
other party — sometimes broad enough to sweep in the contractor's pre-existing tools,
frameworks, or code libraries.
Why it matters: This can strip a freelancer or agency of the reusable assets their
business is actually built on.
Fallback ask: Assignment limited to final deliverables; contractor retains pre-existing IP
and grants a license for its use within the deliverable.

## Termination

Pattern: Asymmetric termination — one party can terminate "at any time, without notice,"
while the other owes 30+ days notice.
Why it matters: Leaves the smaller party unable to walk away from a bad situation while
still on the hook for ongoing obligations.
Fallback ask: Symmetric notice periods for both parties.

## Non-compete / non-solicit

Pattern: Broad geographic scope ("the United States"), long duration (2+ years), and vague
subject matter ("any business that could be considered a competitor").
Why it matters: Many states restrict or void overly broad non-competes; even where
enforceable, this can meaningfully block someone's ability to earn a living.
Fallback ask: Narrow to a specific, named list of direct competitors, 6-12 month duration,
limited to the metro area actually served.

## Payment terms

Pattern: Long payment windows (60-90 days), combined with a right to withhold payment
"at Client's sole discretion" pending a vague satisfaction review.
Why it matters: Creates cash flow risk and an unchecked lever the other party can use to
avoid paying for completed work.
Fallback ask: Net 15-30 payment terms; any withholding tied to specific, written,
objective deliverable criteria — not subjective satisfaction alone.

## Governing law / venue

Pattern: Governing law and venue set to wherever the other party is headquartered, "venue
to be determined solely by Client."
Why it matters: Forces the smaller party to litigate far from home if a dispute arises,
which functionally makes enforcement of their own rights cost-prohibitive.
Fallback ask: Governing law/venue in the small business's home state, or a neutral third
state, or mandatory mediation/arbitration before litigation.

## Auto-renewal

Pattern: Contract auto-renews annually unless cancelled within a narrow window (e.g. 60
days before renewal), often buried mid-document.
Why it matters: Easy to miss the cancellation window and get locked into another term.
Fallback ask: Either strike auto-renewal, or require the other party to send an advance
renewal notice that restarts the cancellation window.

---
Add new entries here whenever the contract agent flags a pattern not yet covered above —
this file is what actually improves over time, more than the code around it.
