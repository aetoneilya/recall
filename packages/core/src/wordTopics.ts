// Explicit Topic/… tags describe a context, unlike provenance tags (a book,
// an import, Claude). The small English fallback also works for old cards,
// packs and offline queues without an AI call or rewriting anybody's tags.
import type { PartOfSpeech } from './types.ts'
import { normalizeTerm } from './words.ts'

export const WORD_TOPICS = [
  'Travel', 'Work', 'Home', 'Food', 'Health', 'Education', 'Relationships',
  'Feelings', 'Money', 'Nature', 'Technology', 'Communication', 'Time', 'Leisure',
] as const

const VOCABULARY: Record<typeof WORD_TOPICS[number], string> = {
  Travel: 'ticket platform train station airport flight luggage suitcase passport visa journey trip travel voyage destination departure arrival passenger fare commute abroad hotel reservation accommodation itinerary sightseeing board depart arrive fly drive ride bus taxi road street traffic vehicle bicycle car transport',
  Work: 'work job office meeting deadline colleague boss employee employer staff career profession project task shift hire recruit resign retire salary promotion interview business occupation workload overtime negotiate delegate appoint postpone submit',
  Home: 'home house room kitchen bedroom bathroom floor ceiling wall window door roof stairs furniture table chair bed sofa shelf cupboard wardrobe garden garage rent tenant landlord household tidy clean wash repair laundry blanket pillow towel',
  Food: 'food meal breakfast lunch dinner restaurant menu waiter bill tip cook bake boil fry eat drink bread rice pasta meat beef pork chicken fish vegetable fruit apple potato tomato onion cheese milk butter egg sugar salt pepper coffee tea water juice hungry thirsty delicious recipe ingredient portion',
  Health: 'health healthy sick ill disease illness symptom pain ache headache fever cough cold doctor nurse hospital clinic medicine treatment prescription appointment patient recover recovery injury wound blood bone breathe exercise diet tired exhausted fatigue diagnosis therapy surgery infection',
  Education: 'school university college lesson lecture teacher student pupil homework exam test grade learn study teach read write book library knowledge skill course degree scholarship research science subject explain understand practise practice revise graduate',
  Relationships: 'family friend friendship neighbour neighbor parent mother father sister brother child children son daughter husband wife partner couple relative relationship wedding marriage marry divorce invite visit guest host greet trust support help forgive argue quarrel reconcile',
  Feelings: 'happy sad angry afraid scared worried anxious anxiety fear joy sorrow grief delight mood emotion feeling lonely proud ashamed jealous disappointed excited surprise surprised astonished bewildered frown smile laugh cry weep scorn coax stifle courage hope regret calm relief',
  Money: 'money price cost pay buy sell spend save borrow lend loan debt cash credit bank account budget income expense profit loss tax investment interest inflation economy economic trade auction bargain afford purchase refund receipt discount cheap expensive wealth poverty',
  Nature: 'nature weather sun rain snow wind storm cloud sky warm hot cool freezing forest tree flower plant leaf grass mountain hill river lake sea ocean beach island animal bird cat dog horse wildlife environment climate pollution drought flood earthquake',
  Technology: 'computer phone screen keyboard mouse software hardware application app website internet network password file folder database server code program programming algorithm data device digital technology download upload install update bug error crash connect connection',
  Communication: 'say tell speak talk ask answer question reply respond message email letter conversation discussion chat call shout whisper mention describe announce inform report express opinion advice suggest persuade convince promise complain communication language translate translation pronounce pronunciation',
  Time: 'time day week month year morning afternoon evening night today tomorrow yesterday hour minute second moment early late soon already still yet before after always never often sometimes usually schedule calendar date duration meanwhile recently eventually',
  Leisure: 'holiday vacation weekend hobby sport game play music song sing dance film movie cinema theatre theater concert museum art paint draw photo photograph camera party fun relax rest walk run swim football tennis chess guitar piano novel story poetry',
}

const TOPICS = new Map(Object.entries(VOCABULARY).flatMap(([topic, terms]) => terms.split(' ').map((term) => [term, topic] as const)))

export function topicTag(tag: string): boolean {
  return /^topic\/\S/i.test(tag)
}

// A different sense may have a different topic; manually added topics and
// provenance always win over a model suggestion.
export function withWordTopics(current: string[], previous: string[], proposed: string[] = []): { tags: string[]; autoTags: string[] } {
  const keep = current.filter((t) => !previous.includes(t))
  const autoTags = keep.some(topicTag) ? [] : proposed.filter((t) => topicTag(t) && !keep.includes(t))
  return { tags: [...new Set([...keep, ...autoTags])], autoTags }
}

export function wordTopic(word: { term: string; pos?: PartOfSpeech | null; tags: readonly string[]; language?: string | null }): string | null {
  const explicit = word.tags.filter(topicTag).map((t) => t.slice(t.indexOf('/') + 1).trim().toLowerCase()).sort()[0]
  if (explicit) return explicit
  if (word.language && word.language !== 'en') return null
  const term = normalizeTerm(word.term)
  // A reservation and a book are different senses of "book".
  if (term === 'book' && word.pos === 'verb') return 'travel'
  return TOPICS.get(term)?.toLowerCase() ?? null
}
