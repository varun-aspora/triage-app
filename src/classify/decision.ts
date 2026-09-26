// Classifier questions for a decision model (src/decisions/), and the map
// from its answers back to a Classification.
//
// Every field is asked in one decide() call, so no question can depend on
// another's answer. subcategory is therefore one choice over every listed
// 'category/subcategory' pair plus none; a pair from a category other than
// the chosen one reads as ''.
//
// Fields and questions:
// - category: choice over the categories file (unknown is always offered).
// - subcategory: choice as above; none -> ''.
// - entities_likely: one yes/no per enabled entity (TRIAGE_ENTITIES).
// - money_moved, misdirected_funds: yes/no.
// - tier_proposed: choice over the tiers.
// - confidence: the probability the model gave its chosen category, else the
//   choice's own confidence, else 0 (which the tier policy sends to strong).
// - images_seen: false. Decision models take no images.
// - matched_pattern_id: not asked; patterns.ts sets it.
// A yes/no counts as yes at YES_THRESHOLD or above.
import * as v from 'valibot';

import { choice, yesNo } from '../decisions/decide.ts';
import type { ChoiceQuestion, DecisionAnswer, DecisionQuestions, YesNoQuestion } from '../decisions/types.ts';
import { ClassificationSchema, type Classification } from '../types/classification.ts';
import { ENTITIES, TIERS, type Entity } from '../types/core.ts';
import type { CategoryEntry } from './prompt.ts';

export const YES_THRESHOLD = 0.5;

/** The subcategory option that maps to ''. */
export const NO_SUBCATEGORY = 'none';

const ENTITY_PREFIX = 'entity_';

const TIER_MEANING: Readonly<Record<(typeof TIERS)[number], string>> = {
  cheap: 'a single known lookup',
  mid: 'a few lookups across one or two services',
  strong: 'multi-entity, money-related or unclear',
};

export type ClassifierQuestions = DecisionQuestions & {
  readonly category: ChoiceQuestion;
  readonly subcategory?: ChoiceQuestion;
  readonly money_moved: YesNoQuestion;
  readonly misdirected_funds: YesNoQuestion;
  readonly tier_proposed: ChoiceQuestion;
};

/** The questions for one classification. entities is the enabled entity list from config. */
export function classifierQuestions(categories: readonly CategoryEntry[], entities: readonly string[]): ClassifierQuestions {
  const categoryOptions: Record<string, { label: string; description: string; signals?: string[]; notes?: string }> = {};
  for (const c of categories) {
    categoryOptions[c.id] = {
      label: c.label,
      description: c.description,
      ...(c.signals.length > 0 ? { signals: c.signals } : {}),
      ...(c.notes !== undefined && c.notes.trim() !== '' ? { notes: c.notes.trim() } : {}),
    };
  }
  if (categoryOptions.unknown === undefined) categoryOptions.unknown = { label: 'Unknown', description: 'Nothing else fits.' };

  const subOptions: Record<string, string | null> = {};
  for (const c of categories) for (const sub of c.subcategories) subOptions[`${c.id}/${sub}`] = null;
  const hasSubcategories = Object.keys(subOptions).length > 0;
  subOptions[NO_SUBCATEGORY] = 'no listed subcategory of the chosen category fits';

  const questions: Record<string, ChoiceQuestion | YesNoQuestion> = {
    category: choice('Which category does this support issue belong to? Pick unknown when none fits.', categoryOptions),
    ...(hasSubcategories
      ? {
          subcategory: choice(
            'Which subcategory fits? Options are category/subcategory; pick one from the category you chose, or none.',
            subOptions,
          ),
        }
      : {}),
  };
  for (const entity of enabledEntities(entities)) {
    const usual = categories.filter((c) => c.typical_entities.includes(entity)).map((c) => c.id);
    const hint = usual.length > 0 ? ` It is usually involved in: ${usual.join(', ')}.` : '';
    questions[`${ENTITY_PREFIX}${entity}`] = yesNo(`Is the ${entity} entity likely involved in this issue?${hint}`);
  }
  questions.money_moved = yesNo('Is a transfer, credit, debit or reversal involved?');
  questions.misdirected_funds = yesNo('Did money go to the wrong account or person?');
  questions.tier_proposed = choice('How hard will this be to investigate?', TIER_MEANING);
  return questions as ClassifierQuestions;
}

// Enabled entities the schema knows, in ENTITIES order.
function enabledEntities(entities: readonly string[]): Entity[] {
  return ENTITIES.filter((e) => entities.includes(e));
}

export type ClassificationOutcome = { ok: true; classification: Classification } | { ok: false; error: string };

/** Maps decide() answers to a Classification. Errors name fields, never values. */
export function classificationFromAnswers(answers: { readonly [name: string]: DecisionAnswer }): ClassificationOutcome {
  const a: { readonly [name: string]: DecisionAnswer | undefined } = answers;
  const category = a.category?.kind === 'choice' ? a.category : undefined;
  if (category === undefined) return { ok: false, error: 'decision answers: no category' };

  let subcategory = '';
  const sub = a.subcategory;
  if (sub?.kind === 'choice' && sub.choice !== NO_SUBCATEGORY) {
    const slash = sub.choice.indexOf('/');
    if (sub.choice.slice(0, slash) === category.choice) subcategory = sub.choice.slice(slash + 1);
  }

  const yes = (name: string): boolean | undefined => {
    const answer = a[name];
    return answer?.kind === 'yes_no' ? answer.yes >= YES_THRESHOLD : undefined;
  };
  const tier = a.tier_proposed?.kind === 'choice' ? a.tier_proposed.choice : undefined;

  const picked = {
    category: category.choice,
    subcategory,
    entities_likely: ENTITIES.filter((e) => yes(`${ENTITY_PREFIX}${e}`) === true),
    money_moved: yes('money_moved'),
    misdirected_funds: yes('misdirected_funds'),
    tier_proposed: tier,
    confidence: categoryConfidence(category),
    images_seen: false,
  };
  const parsed = v.safeParse(ClassificationSchema, picked);
  if (!parsed.success) return { ok: false, error: `decision answers invalid at ${issuePaths(parsed.issues)}` };
  return { ok: true, classification: parsed.output };
}

/** The distinct paths of schema issues, comma separated. Paths only, never the values. */
export function issuePaths(issues: readonly v.BaseIssue<unknown>[]): string {
  return [...new Set(issues.map((i) => v.getDotPath(i) ?? '(root)'))].join(', ');
}

// The probability of the chosen category, else the choice's confidence, else 0.
function categoryConfidence(answer: { choice: string; probabilities?: Readonly<Record<string, number>>; confidence?: number }): number {
  const p = answer.probabilities?.[answer.choice] ?? answer.confidence ?? 0;
  return Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
}
