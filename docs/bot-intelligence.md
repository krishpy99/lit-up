# Bot Intelligence — Design Reference

This document describes the complete design of the Literature bot AI: the knowledge
model every bot maintains, the capabilities layered across four difficulty tiers, and
the reasoning behind each decision.

---

## 1. The Knowledge Table

Every bot, regardless of difficulty, maintains a unified knowledge model over all
54 cards and all N players (both teams). This is the single source of truth for every
decision the bot makes.

### 1.1 Card-level tracking

For each of the 54 cards the bot tracks, per player:

| State | Meaning | How established |
|---|---|---|
| **Confirmed holder** (P = 1) | This player definitely has this card | Witnessed a successful ask transfer |
| **Eliminated** (P = 0) | This player definitely does not have this card | Player asked for it and was denied; or player successfully asked the card away from someone else |
| **Self-held** | Bot's own hand — known with certainty | Own hand |
| **Unknown** | No direct evidence either way | Everything else |

For unknown cards the bot computes a probability distribution across all non-eliminated,
non-self players, weighted by:

- **Hand size prior**: a player with 8 cards is more likely to hold any given unknown
  card than one with 2 cards.
- **Known-in-set bonus** (+5 per confirmed card in the same set): if a player is already
  known to hold other cards in the same set, their probability for the remaining unknowns
  in that set increases.
- **Set-engagement multiplier** (×1.8): if a player has ever asked for a card in a set,
  they must hold at least one card there. Cards in that set are weighted higher for them.

### 1.2 Set-level tracking

Beyond individual cards the bot tracks two things per (player, set) pair:

**Set membership** — does this player hold at least one card in this set?

Established when a player asks for any card in set S: by the rules of Literature, you
can only ask for a card in a set you already hold. One ask → confirmed member.

This is tracked with a confidence level:

- **Hard confirm**: the player is definitely in this set (e.g. they asked directly,
  or a successful ask transfer was witnessed).
- **Soft confirm**: probabilistic — the player probably has a card there but the
  signal could be deceptive (e.g. an echo ask or misdirection).

Which confidence level is assigned depends on who is signalling and the bot's own
difficulty (see section 3.2).

**Set count estimate** — minimum number of cards this player holds in this set.

- Each confirmed card location (via successful ask or own hand) contributes +1.
- Each time a player asks in a set, their minimum for that set is at least 1. If they
  ask in the same set twice on separate turns (needing a base each time), their minimum
  remains 1 unless a card was transferred to them in between.
- Transfers (successful asks) directly increase the confirmed count.

This estimate is a lower bound. The actual count may be higher for cards that have never
been mentioned in any ask.

### 1.3 Search intent tracking

For each player the bot tracks what cards they are actively searching for:

- When player X asks for card C: X is searching for C. X does not have C (already
  eliminated) and considers C findable (X has a base in that set).
- Intent persists until X successfully receives C, or until enough eliminations
  accumulate that X would have deduced C is elsewhere.

This is used by the expert-tier tempo trap (section 4.4).

---

## 2. Set Analysis

Built on top of the knowledge table, set analysis summarises the state of a set from
the bot's perspective at decision time.

| Field | Meaning |
|---|---|
| `teamKnown` | Cards confirmed on the bot's team (own hand + witnessed transfers to teammates + ask-eligibility inferences) |
| `oppKnown` | Cards confirmed on the opponent team (witnessed transfers to opponents) |
| `unknown` | Cards with no confirmed location |
| `canDeclare` | All 6 cards are provably on the bot's team |
| `almostDeclare` | Team has 5, opponents have 0 — one card away |
| `teamExposed` | Bot's team has asked in this set — opponents know the team holds a base |
| `oppExposed` | Opponents have asked in this set — they hold a base here |
| `threatLevel` | 0–1 urgency score (see section 4.3) |

### Ask-eligibility inference (medium+)

When a teammate successfully asks for card C in set S, the transaction log shows C
moving to the teammate. But the teammate had to hold at least one card in set S already
to be eligible to ask. That "base card" was never transferred — it was dealt to them —
so it does not appear in the transaction log.

The inference: teammate's ask in set S → teammate holds at least 1 additional card in
set S beyond what explicit transfers show. This bumps `teamKnown` by 1 (or confirms a
soft-confirmed membership as hard-confirmed) and can trigger an immediate declare when
combined with the bot's own holdings.

Example:
- Bot holds cards 1, 2, 3, 4 of set S.
- Teammate successfully asks opponent for card 5.
- `teamKnown` via transfers = 5. Card 6 is unknown.
- But teammate had to hold a base to ask for card 5. Their base is card 6.
- Inference: card 6 is with the teammate → `teamKnown` = 6 → declare immediately.

Without this inference the bot would spend turns searching for card 6 among opponents.

---

## 3. Hint Inference

In Literature all communication is public. The only way bots signal to each other is
through which cards they ask for and from whom. A "hint" is any ask that reveals
information beyond what is strictly necessary.

### 3.1 What an ask reveals

When player X asks for card C in set S:

1. X holds at least one card in set S (set membership, hard-confirmed).
2. X does not hold card C (X is asking for it).
3. The player being asked does not hold C if the ask fails (elimination).
4. The player being asked does hold C if the ask succeeds (confirmed holder, P=1).

### 3.2 Confidence levels by bot tier

Bots interpret teammate and opponent asks differently depending on their difficulty:

| Bot tier | Teammate ask in set S | Opponent ask in set S |
|---|---|---|
| **Easy** | Not modelled (ignores teammate signals) | Basic elimination only |
| **Medium** | **Hard confirm** — teammate has ≥1 card in S; they are signalling honestly | **Soft confirm** — opponent probably has a card in S |
| **Hard** | **Soft confirm** — aware that echo asks exist; teammate might be doing coordinated misdirection | **Soft confirm** |
| **Expert** | **Soft confirm** | **Soft confirm** |

Why medium hard-confirms teammates but hard/expert only soft-confirms:

Medium bots signal honestly — they ask in a set only when they genuinely need
progress there. So a medium bot observing a teammate ask can trust the signal. Hard and
expert bots know that deceptive asks (echo asks, tempo traps) exist because they
use them. A teammate who is hard or expert might be manufacturing a turn rather than
genuinely holding a card. Since the observing bot cannot inspect the teammate's
difficulty level, hard/expert bots are conservative and soft-confirm all signals.

Opponent signals are always soft-confirmed regardless of the observing bot's tier,
because the observing bot can never see the opponent's difficulty level.

### 3.3 How soft confirms affect the probability model

A soft confirm for "player X has ≥1 card in set S" increases the set-engagement
weight for X (the ×1.8 multiplier) even though the hard-confirmed path was not
triggered. It also increases the set count estimate's lower bound from 0 to "possibly 1."

A hard confirm sets the lower bound to exactly 1 and is reflected directly in
`teamKnown` via the ask-eligibility inference.

---

## 4. Difficulty Tiers

### 4.1 Easy

**Philosophy**: competent probabilistic play, fully self-focused. No teammate
coordination, no meta-game awareness. Plays the best move for its own hand right now.

**Capabilities**:

- Maintains the full knowledge table (eliminations, confirmed holders, hand-size prior).
- Deduction: if eliminations have narrowed a card to exactly one possible holder, asks
  them with certainty — this is basic card-counting any player would do.
- Target selection: picks the opponent with the highest P(holds card) for each
  candidate ask.
- Card selection: picks the ask with the highest overall expected value (pSuccess
  weighted by how close the set is to completion).
- If no ask has a meaningful expected value (e.g. all candidate cards have been
  eliminated from all opponents), falls back to a random legal ask in any set.
- Does not restrict itself to open sets.
- Does not model teammate holdings, set membership per player, or search intent.
- Does not coordinate with teammates.

**What easy does NOT do**: threat urgency, leakage awareness, echo asks, teammate
hint interpretation, or any form of opponent modelling beyond card eliminations.

### 4.2 Medium

**Philosophy**: full probability model plus team coordination. Plays the best move for
the team, not just self.

**Capabilities** (everything in easy, plus):

- **Set membership tracking**: knows which players have at least one card in which sets,
  based on ask history.
- **Ask-eligibility inference**: when a teammate asks in a set, infers their base card
  and updates `teamKnown` accordingly. Can trigger immediate declares that easy would miss.
- **Immediate declare**: actively checks whether a set is provably complete on the team
  after every new piece of evidence, including base card inferences.
- **Teammate hints — hard confirm**: when a teammate asks in set S, treats this as a
  reliable signal that the teammate holds a card there.
- **Opponent hints — soft confirm**: updates probability weights when opponents ask in
  a set.
- **Echo ask**: after a teammate's failed ask for card C in set S, if the bot holds
  cards in S and a different opponent has >15% probability of holding C, asks for C
  from that opponent. Signals "I'm coordinating on this set" and produces another
  elimination if it fails.
- **Strategic scoring**:
  - *Lock-out bonus* (+pSuccess × 50): when the team has 5 of 6 cards in a set and
    zero are with opponents, this ask is the highest-leverage move in the game.
  - *Teammate support bonus* (up to +18): keep working sets that teammates are actively
    engaged in, to close them efficiently.
  - *Speculative penalty* (−(1−pSuccess) × 5): avoid opening the bot's base in a
    poorly-characterised set for a low-confidence ask.

### 4.3 Hard

**Philosophy**: medium plus information warfare. Minimises what opponents can learn,
maximises pressure on exposed sets.

**Capabilities** (everything in medium, plus):

- **Teammate hints — soft confirm only**: aware that echo asks and deceptive plays
  exist; does not blindly trust teammate signals.
- **Leakage penalty** (−8): penalises opening a fresh set (no prior team asks) unless
  the team already has ≥4 cards there. Avoids revealing which sets the team holds
  cards in until the investment is worth the exposure.
- **Threat urgency** (+threatLevel × 30): urgency score per set based on:
  - +0.2 if the bot's team has asked in this set (opponents know we have a base)
  - +0.3 if opponents have also asked in this set (they are actively working it)
  - +0.3 if the team has ≥4 cards (close enough that stripping one card hurts badly)
  - +0.2 if `almostDeclare` (maximum urgency — one card away)
  - Hard bot races to complete threatened sets before opponents strip a key card.
- **End-game bonus** (+pSuccess × 15): when the bot's hand has ≤3 cards, turns are
  scarce. Bias heavily towards high-certainty asks to maximise output in the final
  exchanges.
- **Deprioritise likely-team-held unknowns**: when the team has high concentration in
  a set (4+ cards) and no opponent has ever engaged that set, the remaining unknowns
  are likely with teammates. The bot reduces ask priority for those cards and redirects
  attention to sets where opponent holdings are confirmed.

### 4.4 Expert

**Philosophy**: hard plus opponent modelling. Manufactures tempo advantages by
exploiting what opponents are searching for.

**Capabilities** (everything in hard, plus):

- **Search intent tracking**: maintains, per opponent, which cards they are actively
  looking for (inferred from their ask history). Intent persists until the opponent
  receives the card or deductive evidence changes the picture.
- **Tempo trap**:
  - Condition: opponent O is searching for card C in set S (has asked for C at least
    once). The bot does not hold C. The bot holds another card D in set S, so it is
    eligible to ask.
  - Action: ask opponent O for a different card E in set S (not C).
  - Mechanism: if O does not have E (most likely), the bot gained an elimination and
    O has now been asked about E. O still needs to find C. The bot has not been asked
    about C yet, and no other opponent has signalled they have C. So O's highest-
    probability target for C on their next turn is the bot. O asks the bot for C. The
    bot does not have C. O loses their turn.
  - Net effect: the bot gets one ask, then receives a failed ask (costing the opponent
    a turn) — two productive events in two turns instead of one. The bot does not
    sacrifice any information because it genuinely does not have C.
  - Trap validity conditions:
    - The bot must not hold C (otherwise O would eventually find it through normal play).
    - No other opponent has been seen to hint C is with them (otherwise O will ask them,
      not the bot).
    - The bot holds at least one other card in set S (to be eligible to ask).
  - Trap scoring bonus: the expected value of the trap includes the probability that O
    will waste a turn asking the bot for C, weighted by how few alternative targets O has.
    Fewer alternatives → higher bonus.

---

## 5. Declare Logic

Declare checks run before any ask decision and apply at all difficulty levels.

**Check 1 — direct**: every card in the set is in `teamCards` (the bot's own hand plus
all cards confirmed on the team through explicit ask transfers). Fires immediately.

**Check 2 — inferred**: every card in the set is either in `teamCards`, or has P = 0
for all opponents (all opponents have been eliminated via failed asks). The team must
hold at least one card in the set to be eligible to declare. This covers cards that
were never transferred but that opponents have been fully eliminated from holding.

**Check 3 — ask-eligibility** (medium+): after applying the base card inference
(section 2), if `teamKnown` reaches 6 for any set, declare immediately. This fires
in situations where direct and inferred checks would not yet trigger because a teammate's
base card was never part of any ask transaction.

---

## 6. Candidate Scoring Summary

The score for a candidate ask `(card C, target T)` at each tier:

```
score = pSuccess × (10 + teamKnown × 8)          -- all tiers

      + pSuccess × 50   [if almostDeclare]         -- medium+
      + min(teamAsks, 3) × 6                       -- medium+
      − (1 − pSuccess) × 5  [if speculative]       -- medium+

      − 8               [if fresh set, hard+]       -- hard+
      + threatLevel × 30                            -- hard+
      + pSuccess × 15   [if hand ≤ 3 cards]        -- hard+

      + trapBonus       [if tempo trap eligible]    -- expert only
```

Where `trapBonus` is the expected value of the wasted opponent turn:
```
trapBonus = P(opponent asks bot for C next turn) × 25
```

P(opponent asks bot for C) is estimated as:
```
= pSuccess_for_opponent(C → bot)   -- how likely is bot the best target for C
× P(opponent still searches for C) -- is C still unresolved for them
```

---

## 7. Mixed-Difficulty Games

Bots of different difficulty levels can coexist in the same game. Each bot reasons
purely from public information — all asks are visible to everyone. The difficulty
level of other bots is not observable.

This drives two design constraints:

1. **Conservative hint interpretation for opponents**: since you cannot know an
   opponent bot's level, you can never hard-confirm an opponent signal. Treat all
   opponent asks as soft confirms regardless of what level they might be.

2. **Conservative hint interpretation for hard/expert teammates**: hard and expert
   bots use deceptive asks. A hard/expert bot observing a teammate ask cannot assume
   the teammate is signalling honestly — the teammate might be running a tempo trap
   or echo ask for misdirection. So hard/expert bots soft-confirm even teammate signals.

Medium bots are the exception: they signal honestly and assume teammates do too.
In a mixed game where a medium bot is paired with a hard bot, the medium bot
will over-trust the hard teammate's signals. This is a deliberate design choice —
the medium bot's naivety is part of what makes it medium.
