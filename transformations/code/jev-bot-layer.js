/**
 * Jev bot intelligence layer for RudderStack
 *
 * Tells you who is behind each high-stakes event (a person, an AI agent
 * acting for one, a crawler, or a bot) and whether it is trying to abuse you.
 *
 * How: it sends the event's context to Jev (TypeSafe AI), which answers two
 * typed questions in a single fast call, and writes the verdict onto the event.
 *
 * THE TWO QUESTIONS
 *   kind        What produced this event?   one choice from a fixed list
 *   bad_intent  Is it part of abuse?        probability from 0 to 1
 *
 *   They are asked separately on purpose. A bot farm running real browsers
 *   looks human but has high intent. An AI agent buying for a customer is
 *   a bot with low intent. One "is it a bot?" question gets both wrong.
 *
 * OUTPUT (added to context, same shape as native Bot Management)
 *   context.isBot                true | false (false only when kind is human)
 *   context.bot.category         human | ai_agent | ai_crawler | search_crawler
 *                                | seo_tool | scraper | other_automation
 *   context.bot.badIntent        0 to 1, probability the event is abuse
 *   context.bot.kindConfidence   0 to 1, how sure Jev is about the category
 *   context.bot.actsForUser      true | false, a real person is behind it
 *   context.bot.detectedBy       "jev"
 *   context.bot.name / .url      kept if Bot Management already set them
 *
 * WHAT YOU CAN DO WITH IT
 *   Stop fake signups and fraud      drop or review high badIntent
 *   Keep agent-driven revenue        keep isBot && actsForUser in revenue models
 *   Clean engagement metrics         exclude isBot from DAU, funnels, A/B tests
 *   Measure AI and search visibility track ai_crawler and search_crawler volume
 *   Route by risk                    send mid-range badIntent to manual review
 *
 * USE IT WITH DETERMINISTIC DETECTION
 *   This is an optional layer. Pair it with cheap user-agent rules that catch
 *   known bots for free, so Jev only sees what they can't decide:
 *     RudderStack Bot Management (runs before this transformation)
 *       https://www.rudderstack.com/docs/data-governance/bot-management/#how-bot-management-works
 *     Or add your own user-agent rules at the top of transformEvent, e.g.
 *       https://www.rudderstack.com/docs/transformations/templates/#filter-bot-traffic
 *   Events already categorized are skipped, and only EVALUATE_EVENTS are
 *   sent to Jev. Turn the layer up or down with MODE:
 *     "off"      no calls, no cost
 *     "shadow"   tag only, never drop (start here to measure the value)
 *     "enforce"  also drop events with badIntent >= BAD_INTENT_THRESHOLD
 *
 * SETUP
 *   1. Add TYPESAFE_API_KEY under Settings > Workspace > Credentials > Secrets
 *      before connecting a destination. RudderStack drops the event if
 *      getCredential() errors.
 *   2. If you use Bot Management, set it to "Forward events with a flag",
 *      not "Drop", so bot events still reach this layer.
 */

const MODE = "shadow";
// "off"     skip Jev entirely, zero cost
// "shadow"  tag events, never drop (start here to measure value)
// "enforce" tag events, and drop those with clear bad intent

const TYPESAFE_API_URL = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_API_KEY = getCredential("TYPESAFE_API_KEY");
// If you are on Open Source or Free plans, replace the getCredential("TYPESAFE_API_KEY") with the actual API key.
// Because only Growth/Enterprise plans can use the credential store to store the secrets and get the value with: `getCredential("TYPESAFE_API_KEY")`
// Reference: https://www.rudderstack.com/docs/transformations/credentials/

const TYPESAFE_MODEL = "jev-latest";
const JEV_TIMEOUT_MS = 2000; // Transformations have a 4s limit

// In "enforce" mode, events at or above this are dropped.
// A starting point: tune it with real traffic in shadow mode.
const BAD_INTENT_THRESHOLD = 0.8;

// Only spend a Jev call where a bot costs you money. Edit freely.
const EVALUATE_EVENTS = [
  "Signed Up",
  "Login Attempted",
  "Checkout Started",
  "Order Completed",
  "Coupon Applied",
  "Application Installed",
];

export async function transformEvent(event) {
  if (MODE === "off" || !shouldEvaluate(event)) return event;

  let result;
  try {
    result = await askJev(event);
  } catch (err) {
    // Fail open: a third-party hiccup must never stall the pipeline.
    log("jev: skipped -", err.message);
    return event;
  }

  const { kind, kindConfidence, badIntent } = result;
  log("jev:", event.type, event.event || "", "->", kind, badIntent);

  if (badIntent >= BAD_INTENT_THRESHOLD && MODE === "enforce") return null;

  // Tag every evaluated event, humans included, so shadow mode shows
  // exactly what Jev decided. Same shape as native Bot Management.
  event.context = event.context || {};
  event.context.isBot = kind !== "human";
  event.context.bot = {
    ...(event.context.bot || {}), // keep name/url if Bot Management set them
    category: kind,
    badIntent: Math.round(badIntent * 1000) / 1000,
    actsForUser: kind === "ai_agent", // a real person is behind it
    detectedBy: "jev",
    kindConfidence,
  };
  return event;
}

function shouldEvaluate(event) {
  // Already categorized by an earlier layer: don't pay twice.
  if (event.context?.bot?.category) return false;
  return event.type === "identify" || EVALUATE_EVENTS.includes(event.event);
}

async function askJev(event) {
  const res = await fetchV2(TYPESAFE_API_URL, {
    method: "POST",
    timeout: JEV_TIMEOUT_MS,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TYPESAFE_API_KEY}`,
    },
    body: JSON.stringify({
      model: TYPESAFE_MODEL,
      state: buildState(event),
      // Both questions run in parallel in a single call.
      questions: {
        kind: {
          type: "choice",
          instructions: "What produced this web or app event?",
          criteria: {
            human: "A person using a browser or app directly",
            ai_agent: "An AI assistant or agent acting for a live user: often a headless or automated browser, a session that started from an AI assistant (chatgpt.com, claude.ai, perplexity.ai, gemini.google.com), and a logged-in user completing a normal task",
            ai_crawler: "An AI company's crawler building a training set or answer index",
            search_crawler: "A search engine crawler",
            seo_tool: "A third-party SEO, backlink or site-audit crawler",
            scraper: "Undeclared automation harvesting content or prices",
            other_automation: "Automated, purpose unclear (scripts, monitors, previews)",
          },
        },
        bad_intent: {
          type: "noul",
          instructions:
            "Whatever produced it, is this event part of abuse: fake signups, credential stuffing, card or coupon testing, install fraud, scalping, or bulk unauthorized extraction?",
          criteria: {
            true: "Disposable or templated identity, anonymizing network, repeated high-value attempts, impossible timing",
            false: "Plausible identity and behavior for what it claims to be",
          },
        },
      },
    }),
  });

  if (res.status !== 200) throw new Error(`status ${res.status}`);

  // Response shape:
  // { answers: {
  //     kind:       { type: "choice", choice: "human", confidence: 0.67, probabilities: {...} },
  //     bad_intent: { type: "noul", noul: 0.81 } } }
  const answers = res.body?.answers;
  const kind = answers?.kind?.choice;
  const kindConfidence = answers?.kind?.confidence;
  const badIntent = answers?.bad_intent?.noul;

  if (typeof badIntent !== "number" || typeof kind !== "string") {
    throw new Error("unexpected response shape");
  }
  return { kind, kindConfidence, badIntent };
}

function buildState(event) {
  const ctx = event.context || {};
  const email = ctx.traits?.email || "";
  return {
    eventType: event.type,
    eventName: event.event || null,
    channel: event.channel || null,
    userAgent: ctx.userAgent || null,
    ip: event.request_ip || ctx.ip || null,
    referrer: ctx.page?.referrer || null,
    initialReferrer: ctx.page?.initial_referrer || null,
    isLoggedIn: Boolean(event.userId),
    pageUrl: ctx.page?.url || null,
    screen: ctx.screen || null,
    device: ctx.device || null,
    locale: ctx.locale || null,
    timezone: ctx.timezone || null,
    // Send the pattern of the identity, never the identity itself:
    // nearly all the fraud signal, none of the PII.
    emailDomain: email.split("@")[1] || null,
    emailLocalShape: shape(email.split("@")[0]),
    nameShape: shape(ctx.traits?.name),
    properties: event.properties || null,
  };
}

// "User 48213" -> "Aaaa ddddd": keeps the pattern, drops the value.
function shape(str) {
  return str
    ? String(str).replace(/[A-Z]/g, "A").replace(/[a-z]/g, "a").replace(/[0-9]/g, "d")
    : null;
}