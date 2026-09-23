# Jev Bot Intelligence Layer for event stream data

A RudderStack Transformation that tells you who is behind each high-stakes event (a human, an AI agent acting for one, a crawler, or a bot) and whether it is trying to abuse you, using [Jev](https://typesafe.ai) by TypeSafe AI.

Rule-based bot detection asks "is this a known bot?". This layer asks two
questions it can't answer: **what kind of traffic is this**, and **what is it
trying to do**. That separation catches bot farms running real browsers, and
keeps AI agents buying on behalf of real customers out of your block list.

## What it adds to each evaluated event


| Field                        | Values                                                                                         | Meaning                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------- |
| `context.isBot`              | `true` / `false`                                                                               | `false` only when kind is `human`  |
| `context.bot.category`       | `human`, `ai_agent`, `ai_crawler`, `search_crawler`, `seo_tool`, `scraper`, `other_automation` | What produced the event            |
| `context.bot.badIntent`      | 0 to 1                                                                                         | Probability the event is abuse     |
| `context.bot.kindConfidence` | 0 to 1                                                                                         | How sure Jev is about the category |
| `context.bot.actsForUser`    | `true` / `false`                                                                               | A real person is behind it         |
| `context.bot.detectedBy`     | `"jev"`                                                                                        | Which layer tagged it              |




## Quick start

1. Add `TYPESAFE_API_KEY` under **Settings > Workspace > Credentials > Secrets**.
2. Create a new JavaScript transformation and paste `transformations/code/jev-bot-layer.js`.
3. Import the events in `transformations/code/testevents.json` and run them.
4. Keep `MODE = "shadow"` until you trust the verdicts, then switch to `"enforce"`.

If you use [RudderStack Bot Management](https://www.rudderstack.com/docs/data-governance/bot-management/),
set it to **Forward events with a flag** so bot events still reach this layer.

## Test cases


| #   | Scenario                                   | Expected                                              |
| --- | ------------------------------------------ | ----------------------------------------------------- |
| 1   | Bot farm signup in a real browser          | `human`, `badIntent` >= 0.8 (dropped in enforce mode) |
| 2   | AI agent checkout for a logged-in customer | `ai_agent`, `actsForUser: true`, low `badIntent`      |
| 3   | Android emulator install fraud             | `other_automation`, `badIntent` >= 0.8                |
| 4   | Real person signing up                     | `human`, low `badIntent`                              |


Jev is probabilistic, so `badIntent` and `kindConfidence` vary slightly
between runs. Judge a test by the expected column, not exact decimals.

## Make it yours

- Edit `EVALUATE_EVENTS` to control which events are evaluated (and your cost).
- Tune `BAD_INTENT_THRESHOLD` using real traffic in shadow mode.
- Add your own user-agent rules at the top of `transformEvent`, e.g. the
[bot filter template](https://www.rudderstack.com/docs/transformations/templates/#filter-bot-traffic).

