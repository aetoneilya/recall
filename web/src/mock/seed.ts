// Seed data for mock mode: an English deck with IPA, examples and notes,
// Claude's inbox proposals, autofill drafts and a vocabulary-test sample.
import type { Cefr, Example, PartOfSpeech } from '@recall/core'
import type { Draft } from '../lib/types.ts'

// A card's synthesised history: 'new', 'due' (review due today, fading),
// 'later' (review due in days, known), 'mastered' (stability ≥ 21 days),
// 'learning' (relearning step due now), 'suspended' (a review card, suspended).
export type Plan = 'new' | 'due' | 'later' | 'mastered' | 'learning' | 'suspended'

export interface SeedWord {
  term: string
  pos: PartOfSpeech
  translations: string[]
  ipa: string | null
  examples: Example[]
  note?: string
  tags?: string[]
  cefr: Cefr | null
  freqRank: number | null
  // [forward, reverse], or a word that has no studied cards yet.
  plan: [Plan, Plan] | 'inbox' | 'rejected'
}

const ex = (text: string, translation: string): Example => ({ text, translation })
const WH = 'Wuthering Heights'
const ECO = 'The Economist'

export const words: SeedWord[] = [
  { term: 'to frown', pos: 'verb', translations: ['хмуриться', 'морщить лоб'], ipa: 'fraʊn', examples: [ex('Heathcliff frowned at the letter and tossed it into the fire.', 'Хитклиф нахмурился, глядя на письмо, и бросил его в огонь.')], note: 'обычно frown at smb/smth — хмуро смотреть на кого-то', tags: [WH], cefr: 'B2', freqRank: 6800, plan: ['due', 'later'] },
  { term: 'moor', pos: 'noun', translations: ['вересковая пустошь', 'болото'], ipa: 'mʊr', examples: [ex('The wind howled across the moor all night.', 'Всю ночь над пустошью выл ветер.')], tags: [WH], cefr: 'C1', freqRank: 9800, plan: ['learning', 'later'] },
  { term: 'to loathe', pos: 'verb', translations: ['ненавидеть', 'питать отвращение'], ipa: 'loʊð', examples: [ex('She loathed the idea of moving back to the city.', 'Ей была отвратительна мысль о возвращении в город.')], note: 'сильнее, чем hate; звучит книжно', tags: [WH], cefr: 'C1', freqRank: 11200, plan: ['mastered', 'due'] },
  { term: 'sullen', pos: 'adjective', translations: ['угрюмый', 'мрачный', 'надутый'], ipa: 'ˈsʌlən', examples: [ex('A sullen silence settled over the kitchen.', 'На кухне повисло угрюмое молчание.')], tags: [WH], cefr: 'C1', freqRank: 12400, plan: ['later', 'due'] },
  { term: 'to linger', pos: 'verb', translations: ['задерживаться', 'медлить', 'сохраняться'], ipa: 'ˈlɪŋɡɚ', examples: [ex('The smell of smoke lingered in the hall.', 'В прихожей ещё долго держался запах дыма.')], tags: ['The Guardian', 'vocab'], cefr: 'B2', freqRank: 7300, plan: ['mastered', 'due'] },
  { term: 'wistful', pos: 'adjective', translations: ['задумчиво-грустный', 'тоскующий'], ipa: 'ˈwɪstfəl', examples: [ex('He gave a wistful smile when the train pulled away.', 'Когда поезд тронулся, он грустно улыбнулся.')], tags: ['vocab'], cefr: 'C2', freqRank: 15800, plan: ['later', 'due'] },
  { term: 'to scorn', pos: 'verb', translations: ['презирать', 'отвергать с презрением'], ipa: 'skɔrn', examples: [ex('They scorned every offer of help.', 'Они с презрением отвергали любую помощь.')], tags: [WH], cefr: 'C1', freqRank: 10900, plan: ['due', 'new'] },
  { term: 'uncouth', pos: 'adjective', translations: ['грубый', 'неотёсанный'], ipa: 'ʌnˈkuθ', examples: [ex('His uncouth manners shocked the guests.', 'Его грубые манеры шокировали гостей.')], tags: [WH], cefr: 'C2', freqRank: 21500, plan: ['later', 'later'] },
  { term: 'to brood', pos: 'verb', translations: ['размышлять', 'хандрить'], ipa: 'brud', examples: [ex('Stop brooding over what she said.', 'Перестань хандрить из-за её слов.')], note: 'brood over/about smth', cefr: 'C1', freqRank: 13900, plan: ['mastered', 'mastered'] },
  { term: 'threshold', pos: 'noun', translations: ['порог'], ipa: 'ˈθrɛʃˌhoʊld', examples: [ex('She paused on the threshold, unsure whether to enter.', 'Она остановилась на пороге, не решаясь войти.')], cefr: 'B2', freqRank: 4100, plan: ['due', 'mastered'] },
  { term: 'relentless', pos: 'adjective', translations: ['неумолимый', 'беспощадный'], ipa: 'rɪˈlɛntləs', examples: [ex('The relentless rain kept everyone indoors.', 'Непрекращающийся дождь держал всех дома.')], tags: [ECO], cefr: 'C1', freqRank: 8600, plan: ['new', 'new'] },
  { term: 'to dwindle', pos: 'verb', translations: ['сокращаться', 'убывать'], ipa: 'ˈdwɪndəl', examples: [ex('Their savings dwindled over the winter.', 'За зиму их сбережения растаяли.')], tags: [ECO], cefr: 'C1', freqRank: 14200, plan: ['new', 'new'] },
  { term: 'eerie', pos: 'adjective', translations: ['жуткий', 'зловещий'], ipa: 'ˈɪri', examples: [ex('An eerie light flickered in the window.', 'В окне мерцал зловещий свет.')], tags: [WH], cefr: 'B2', freqRank: 13100, plan: ['new', 'new'] },
  { term: 'to coax', pos: 'verb', translations: ['уговаривать', 'задабривать'], ipa: 'koʊks', examples: [ex('She coaxed the cat out from under the bed.', 'Она выманила кота из-под кровати.')], cefr: 'C1', freqRank: 16700, plan: ['new', 'new'] },
  { term: 'to wane', pos: 'verb', translations: ['убывать', 'ослабевать'], ipa: 'weɪn', examples: [ex('Public interest in the case began to wane.', 'Интерес публики к делу начал угасать.')], tags: [ECO], cefr: 'C1', freqRank: 12800, plan: ['mastered', 'mastered'] },
  { term: 'a far cry from', pos: 'idiom', translations: ['совсем не то, что', 'далеко до'], ipa: 'ə fɑr kraɪ frəm', examples: [ex('The hotel was a far cry from the photos online.', 'Отель был совсем не таким, как на фото в интернете.')], note: 'подчёркивает большую разницу между ожиданием и реальностью', cefr: 'B2', freqRank: null, plan: ['due', 'later'] },
  { term: 'to put up with', pos: 'phrasal_verb', translations: ['терпеть', 'мириться с'], ipa: 'pʊt ʌp wɪθ', examples: [ex("I can't put up with this noise any longer.", 'Я больше не могу терпеть этот шум.')], cefr: 'B1', freqRank: 310, plan: ['mastered', 'later'] },
  { term: 'to give up', pos: 'phrasal_verb', translations: ['сдаваться', 'бросать'], ipa: 'ɡɪv ʌp', examples: [ex("Don't give up now — you're almost there.", 'Не сдавайся сейчас — ты почти у цели.')], cefr: 'A2', freqRank: 190, plan: ['mastered', 'mastered'] },
  { term: 'dreary', pos: 'adjective', translations: ['тоскливый', 'унылый'], ipa: 'ˈdrɪri', examples: [ex('It was a dreary November afternoon.', 'Был тоскливый ноябрьский день.')], cefr: 'B2', freqRank: 12300, plan: ['mastered', 'mastered'] },
  { term: 'thorough', pos: 'adjective', translations: ['тщательный', 'основательный'], ipa: 'ˈθɝoʊ', examples: [ex('The police carried out a thorough search.', 'Полиция провела тщательный обыск.')], cefr: 'B2', freqRank: 4600, plan: ['mastered', 'mastered'] },
  { term: 'to stumble', pos: 'verb', translations: ['спотыкаться', 'запинаться'], ipa: 'ˈstʌmbəl', examples: [ex('He stumbled on the stairs.', 'Он споткнулся на лестнице.')], cefr: 'B2', freqRank: 7900, plan: ['mastered', 'later'] },
  { term: 'reluctant', pos: 'adjective', translations: ['неохотный', 'нежелающий'], ipa: 'rɪˈlʌktənt', examples: [ex('She was reluctant to admit her mistake.', 'Ей не хотелось признавать ошибку.')], cefr: 'B2', freqRank: 4900, plan: ['mastered', 'mastered'] },
  { term: 'to cherish', pos: 'verb', translations: ['лелеять', 'дорожить'], ipa: 'ˈtʃɛrɪʃ', examples: [ex('I cherish the time we spent together.', 'Я дорожу временем, которое мы провели вместе.')], cefr: 'B2', freqRank: 8200, plan: ['later', 'mastered'] },
  { term: 'grief', pos: 'noun', translations: ['горе', 'скорбь'], ipa: 'ɡrif', examples: [ex('Her grief was too deep for words.', 'Её горе было не выразить словами.')], cefr: 'B2', freqRank: 5200, plan: ['mastered', 'mastered'] },
  { term: 'to whet', pos: 'verb', translations: ['разжигать (аппетит, интерес)', 'точить'], ipa: 'wɛt', examples: [ex('The trailer whetted my appetite for the film.', 'Трейлер разжёг мой интерес к фильму.')], note: "чаще всего whet smb's appetite", cefr: 'C2', freqRank: 19800, plan: ['suspended', 'suspended'] },
  { term: 'hindsight', pos: 'noun', translations: ['взгляд в прошлое', 'задним числом'], ipa: 'ˈhaɪndˌsaɪt', examples: [ex('In hindsight, we should have left earlier.', 'Задним числом понятно, что надо было уехать раньше.')], note: 'in hindsight — оглядываясь назад', cefr: 'C1', freqRank: 11800, plan: ['later', 'suspended'] },
  { term: 'to tease', pos: 'verb', translations: ['дразнить', 'подшучивать'], ipa: 'tiz', examples: [], cefr: 'B1', freqRank: 6100, plan: ['later', 'later'] },
  { term: 'gloomy', pos: 'adjective', translations: ['мрачный', 'хмурый'], ipa: 'ˈɡlumi', examples: [], cefr: 'B1', freqRank: 6900, plan: ['mastered', 'mastered'] },
  { term: 'dusk', pos: 'noun', translations: ['сумерки'], ipa: 'dʌsk', examples: [ex('The streetlights came on at dusk.', 'С наступлением сумерек зажглись фонари.')], cefr: 'B2', freqRank: 8700, plan: ['mastered', 'mastered'] },
  { term: 'to mutter', pos: 'verb', translations: ['бормотать', 'ворчать'], ipa: 'ˈmʌtɚ', examples: [ex('He muttered something under his breath.', 'Он что-то пробормотал себе под нос.')], tags: [WH], cefr: 'B2', freqRank: 9300, plan: ['due', 'due'] },
  { term: 'ubiquitous', pos: 'adjective', translations: ['вездесущий', 'повсеместный'], ipa: 'juˈbɪkwɪtəs', examples: [ex('Smartphones have become ubiquitous.', 'Смартфоны стали повсеместными.')], tags: [ECO], cefr: 'C2', freqRank: 14900, plan: ['mastered', 'later'] },
  { term: 'to strive', pos: 'verb', translations: ['стремиться', 'бороться'], ipa: 'straɪv', examples: [ex('She strove to keep the family together.', 'Она изо всех сил старалась сохранить семью.')], tags: [WH], cefr: 'C1', freqRank: 7100, plan: ['due', 'later'] },
  { term: 'to cope', pos: 'verb', translations: ['справляться'], ipa: 'koʊp', examples: [ex('She coped well with the pressure.', 'Она хорошо справлялась с давлением.')], note: 'cope with smth', cefr: 'B1', freqRank: 3300, plan: ['mastered', 'mastered'] },
  { term: 'bewildered', pos: 'adjective', translations: ['озадаченный', 'сбитый с толку'], ipa: 'bɪˈwɪldɚd', examples: [ex('He looked bewildered by the question.', 'Вопрос явно сбил его с толку.')], cefr: 'C1', freqRank: 17100, plan: ['new', 'new'] },
  { term: 'to stifle', pos: 'verb', translations: ['подавлять', 'душить'], ipa: 'ˈstaɪfəl', examples: [ex('She stifled a yawn.', 'Она подавила зевок.')], cefr: 'C1', freqRank: 15300, plan: ['new', 'new'] },
  { term: "to hold one's tongue", pos: 'idiom', translations: ['держать язык за зубами', 'промолчать'], ipa: 'hoʊld wʌnz tʌŋ', examples: [ex('I wanted to argue but held my tongue.', 'Мне хотелось поспорить, но я промолчал.')], cefr: 'B2', freqRank: null, plan: ['later', 'due'] },

  // Claude's proposals.
  { term: 'to seethe', pos: 'verb', translations: ['кипеть (от злости)', 'бурлить'], ipa: 'sið', examples: [ex('He was seething with rage after the meeting.', 'После совещания он кипел от ярости.')], note: 'seethe with anger/rage; о злости, которую сдерживают', tags: ['The Guardian: “The art of losing your temper”', 'the guardian'], cefr: 'C1', freqRank: 18900, plan: 'inbox' },
  { term: 'to fathom', pos: 'verb', translations: ['понимать', 'постигать'], ipa: 'ˈfæðəm', examples: [ex("I can't fathom why she left so suddenly.", 'Не могу понять, почему она так внезапно ушла.')], note: 'обычно в отрицании: can’t fathom', tags: [WH], cefr: 'C1', freqRank: 16100, plan: 'inbox' },
  { term: 'brazen', pos: 'adjective', translations: ['наглый', 'бесстыдный'], ipa: 'ˈbreɪzən', examples: [ex('It was a brazen attempt to rewrite history.', 'Это была наглая попытка переписать историю.')], tags: [ECO], cefr: 'C2', freqRank: 17600, plan: 'inbox' },
  { term: 'a blessing in disguise', pos: 'idiom', translations: ['не было бы счастья, да несчастье помогло'], ipa: 'ə ˈblɛsɪŋ ɪn dɪsˈɡaɪz', examples: [ex('Losing that job was a blessing in disguise.', 'Потеря той работы оказалась к лучшему.')], cefr: 'B2', freqRank: null, plan: 'inbox' },
  { term: 'to gallivant', pos: 'verb', translations: ['шататься', 'развлекаться'], ipa: 'ˈɡæləˌvænt', examples: [], cefr: 'C2', freqRank: 27400, plan: 'rejected' },
]

// ✨ Autofill senses. `keys` (mock-internal) let a hint pick that sense.
export interface Sense extends Draft {
  keys?: string[]
}

const d = (term: string, pos: PartOfSpeech, translations: string[], ipa: string | null, examples: Example[], note: string | null, cefr: Cefr | null, keys?: string[]): Sense => ({
  term, pos, translations, ipa, examples, note, cefr, keys,
})

// Keyed by the normalised term (lowercase, no leading "to ").
export const autofillDictionary: Record<string, { senses: Sense[]; freqRank: number | null }> = {
  bank: {
    freqRank: 1150,
    senses: [
      d('bank', 'noun', ['банк'], 'bæŋk', [ex('I need to go to the bank before it closes.', 'Мне нужно зайти в банк, пока он не закрылся.')], null, 'A1', ['money', 'деньги', 'account']),
      d('bank', 'noun', ['берег (реки)'], 'bæŋk', [ex('We had a picnic on the bank of the river.', 'Мы устроили пикник на берегу реки.')], 'о реке, канале; о море — shore', 'B1', ['river', 'река', 'берег', 'water']),
      d('to bank on', 'phrasal_verb', ['рассчитывать на', 'полагаться на'], 'bæŋk ɑn', [ex("Don't bank on him being on time.", 'Не рассчитывай, что он придёт вовремя.')], 'разговорное; часто в отрицании', 'B2', ['rely', 'count', 'рассчитывать']),
    ],
  },
  run: {
    freqRank: 220,
    senses: [
      d('to run', 'verb', ['бежать', 'бегать'], 'rʌn', [ex('She runs five kilometres every morning.', 'Она каждое утро пробегает пять километров.')], null, 'A1', ['sport', 'jog']),
      d('to run', 'verb', ['руководить', 'управлять'], 'rʌn', [ex('Her parents run a small hotel.', 'Её родители держат небольшую гостиницу.')], 'run a business/company/shop', 'B1', ['business', 'company', 'manage', 'hotel']),
      d('run', 'noun', ['пробежка', 'серия'], 'rʌn', [ex('I go for a run before work.', 'Перед работой я выхожу на пробежку.')], null, 'A2', ['jogging']),
    ],
  },
  bleak: {
    freqRank: 9500,
    senses: [
      d('bleak', 'adjective', ['мрачный', 'безрадостный', 'унылый'], 'blik', [ex('The economic outlook remains bleak.', 'Экономические перспективы остаются мрачными.')], 'о перспективах, будущем; о местности — голый, продуваемый ветром', 'C1', ['future', 'outlook']),
      d('bleak', 'adjective', ['голый', 'открытый всем ветрам'], 'blik', [ex('A bleak hillside stretched before them.', 'Перед ними тянулся голый склон.')], null, 'C1', ['landscape', 'hill', 'moor']),
    ],
  },
  seethe: {
    freqRank: 18900,
    senses: [d('to seethe', 'verb', ['кипеть (от злости)', 'бурлить'], 'sið', [ex('She was seething with anger.', 'Она кипела от злости.')], 'seethe with anger/rage', 'C1')],
  },
  serendipity: {
    freqRank: 26800,
    senses: [d('serendipity', 'noun', ['счастливая случайность', 'интуитивная прозорливость'], 'ˌsɛrənˈdɪpəti', [ex('They met by pure serendipity.', 'Они познакомились по чистой случайности.')], 'книжное', 'C2')],
  },
  'put up with': {
    freqRank: 310,
    senses: [d('to put up with', 'phrasal_verb', ['терпеть', 'мириться с'], 'pʊt ʌp wɪθ', [ex("I won't put up with his rudeness.", 'Я не стану терпеть его грубость.')], null, 'B1')],
  },
  gaunt: {
    freqRank: 19400,
    senses: [d('gaunt', 'adjective', ['измождённый', 'исхудалый'], 'ɡɔnt', [ex('His face was gaunt and pale.', 'Его лицо было измождённым и бледным.')], 'о худобе от болезни или голода', 'C2')],
  },
  dwell: {
    freqRank: 7700,
    senses: [
      d('to dwell on', 'phrasal_verb', ['зацикливаться на', 'подолгу думать о'], 'dwɛl ɑn', [ex("Don't dwell on the past.", 'Не зацикливайся на прошлом.')], null, 'B2', ['think', 'past']),
      d('to dwell', 'verb', ['жить', 'обитать'], 'dwɛl', [ex('Strange creatures dwell in the deep sea.', 'В глубинах моря обитают странные существа.')], 'книжное', 'C1', ['live', 'place', 'sea']),
    ],
  },
  brittle: {
    freqRank: 13800,
    senses: [d('brittle', 'adjective', ['хрупкий', 'ломкий'], 'ˈbrɪtəl', [ex('Old paper becomes brittle.', 'Старая бумага становится ломкой.')], 'о материалах; о характере — неустойчивый', 'C1')],
  },
  frown: {
    freqRank: 6800,
    senses: [
      d('to frown', 'verb', ['хмуриться', 'морщить лоб'], 'fraʊn', [ex('He frowned at the bill.', 'Он нахмурился, глядя на счёт.')], 'frown at smb/smth', 'B2', ['face']),
      d('frown', 'noun', ['хмурый взгляд', 'нахмуренные брови'], 'fraʊn', [ex('She looked up with a frown.', 'Она подняла глаза, нахмурившись.')], null, 'B2', ['look']),
      d('to frown on', 'phrasal_verb', ['не одобрять'], 'fraʊn ɑn', [ex('The school frowns on mobile phones in class.', 'Школа не одобряет телефоны на уроках.')], null, 'C1', ['disapprove', 'одобрять']),
    ],
  },
  ominous: {
    freqRank: 12100,
    senses: [d('ominous', 'adjective', ['зловещий', 'угрожающий'], 'ˈɑmənəs', [ex('There was an ominous silence.', 'Повисла зловещая тишина.')], null, 'C1')],
  },
  'dog-eared': {
    freqRank: null,
    senses: [d('dog-eared', 'adjective', ['потрёпанный', 'с загнутыми уголками'], 'ˈdɔɡˌɪrd', [ex('She kept a dog-eared copy of the novel by her bed.', 'У её кровати лежал потрёпанный экземпляр романа.')], 'о книгах и страницах', 'C2')],
  },
}

// Vocabulary-test sample: 4 real words per 1000-rank band (1k…30k) and
// pseudowords, taken from server/data/vocab-test.json.
export const testBands: string[][] = [["away","choice","coach","culture"],["approved","background","bond","candidate"],["absence","acknowledge","alien","amendment"],["array","biology","breakdown","calorie"],["bailey","bankruptcy","bicycle","collar"],["accidental","aftermath","alumnus","bronco"],["align","amusing","arrogant","bunker"],["absorption","arthritis","bloc","bowel"],["abuser","appraisal","arbor","assay"],["anchorage","anthropologist","apron","barricade"],["acorn","afloat","barbaric","compulsive"],["achievable","aesthetically","amphetamine","annotation"],["acknowledgment","aquifer","arbitrator","articulation"],["adrenal","breather","capillary","cardiologist"],["adage","affront","beehive","carbide"],["allay","alluvial","awning","callus"],["atherosclerosis","aural","bracken","bridegroom"],["algal","anesthesiologist","appropriateness","cleverness"],["abattoir","admixture","artifice","bevel"],["anarchic","balaclava","belay","bevy"],["airmail","bullfrog","burgher","calyx"],["absolutism","airfoil","artificer","bunion"],["ablative","audiology","bituminous","buckaroo"],["alphabetize","asymptotically","audiologist","bittern"],["acquisitive","acrostic","ambergris","bicentenary"],["adulteress","afterbirth","artilleryman","bronc"],["adventitious","aeronautic","aforethought","brittleness"],["alienist","attributive","boysenberry","ceremonious"],["abstemious","advisability","aftereffect","alembic"],["angularity","backslider","bakeshop","biggish"]]

export const pseudowords: string[] = ["abirator","agatato","annitute","ascrel","avatut","boollat","camoster","chergen","clarocal","datralt","dicarce","drasol","feselago","flacral","garlenor","glitur","gunician","herticel","homalage","inisary","latitese","ligamort","matorast","mitato","mutatain","nersark","ocemar","orpeac","pilatin","prochy","redicele","rodomary","setict","sketink","strincor","taitoon","topecul","tutamin","urrac","viotince"]

// server/data/vocab-scale.json as the server's parseScale returns it (sorted by size).
export const scale = {
  unit: 'lemmas',
  calibration: { adultSize: 42000, expectedInList: 26686, listSize: 30000 },
  points: [{"id":"A1","size":1000,"label":"CEFR A1 learner","labelRu":"Начинающий A1","emoji":"🌱","group":"learner","range":[0,1500],"approximate":false,"source":"Meara & Milton (2003) via Milton (2010), Table 5: X_Lex < 1500 lemmas; value = rough midpoint (range is open at the bottom)","url":"https://www.eurosla.org/monographs/EM01/211-232Milton.pdf"},{"id":"A2","size":2000,"label":"CEFR A2 learner","labelRu":"Элементарный A2","emoji":"🧳","group":"learner","range":[1500,2500],"approximate":false,"source":"Meara & Milton (2003) via Milton (2010), Table 5: X_Lex 1500-2500","url":"https://www.eurosla.org/monographs/EM01/211-232Milton.pdf"},{"id":"B1","size":3000,"label":"CEFR B1 learner","labelRu":"Средний B1","emoji":"🚲","group":"learner","range":[2750,3250],"approximate":false,"source":"Meara & Milton (2003) via Milton (2010), Table 5: X_Lex 2750-3250 (Milton & Alexiou 2020 quote 2500-3250)","url":"https://www.eurosla.org/monographs/EM01/211-232Milton.pdf"},{"id":"B2","size":3500,"label":"CEFR B2 learner","labelRu":"Выше среднего B2","emoji":"🚗","group":"learner","range":[3250,3750],"approximate":false,"source":"Meara & Milton (2003) via Milton (2010), Table 5: X_Lex 3250-3750","url":"https://www.eurosla.org/monographs/EM01/211-232Milton.pdf"},{"id":"C1","size":4125,"label":"CEFR C1 learner","labelRu":"Продвинутый C1","emoji":"✈️","group":"learner","range":[3750,4500],"approximate":false,"source":"Meara & Milton (2003) via Milton (2010), Table 5: X_Lex 3750-4500","url":"https://www.eurosla.org/monographs/EM01/211-232Milton.pdf"},{"id":"C2","size":4750,"label":"CEFR C2 learner","labelRu":"Владение C2","emoji":"🚀","group":"learner","range":[4500,5000],"approximate":false,"source":"Meara & Milton (2003) via Milton (2010), Table 5: X_Lex 4500-5000. X_Lex is capped at 5000, so this is a floor; Nation (see Vocabulary and the CEFR, Victoria Univ.) suggests 7000-9000 word families for C2","url":"https://www.eurosla.org/monographs/EM01/211-232Milton.pdf"},{"id":"child5","size":6000,"label":"5-year-old child","labelRu":"Ребёнок 5 лет","emoji":"👶","group":"native","range":[5400,6750],"approximate":true,"source":"Nation & Waring (1997): 4000-5000 word families at school entry, converted to lemmas x1.35 (approximate; original unit = word families)","url":"https://www.lextutor.ca/research/nation_waring_97.html"},{"id":"child10","size":12500,"label":"10-year-old child","labelRu":"Школьник 10 лет","emoji":"🎒","group":"native","range":[11800,13300],"approximate":true,"source":"Biemiller & Slonim (2001): ~8,400 root words by grade 5; Nation & Waring (1997) rule of 1000 families/year gives ~9,500; converted to lemmas x1.4 (approximate)","url":"https://eric.ed.gov/?id=EJ640530"},{"id":"shakespeare","size":18500,"label":"Shakespeare's published vocabulary","labelRu":"Шекспир (то, что написал)","emoji":"🎭","group":"fun","range":[18500,39000],"approximate":true,"source":"Efron & Thisted (1976), Biometrika 63(3):435-447: 31,534 distinct word forms in his works (types, incl. inflections, probably names); converted to lemmas /1.7 (Brysbaert et al. 2016, types = 1.7 x lemmas) = ~18,500; they estimate he knew >= 66,500 types (~39,000 lemmas). Measures words USED, not known","url":"https://doi.org/10.1093/biomet/63.3.435"},{"id":"teen16","size":27000,"label":"16-year-old","labelRu":"Подросток 16 лет","emoji":"🎧","group":"native","range":[22000,32000],"approximate":true,"source":"Interpolation, not a measurement: Nation & Waring (1997) 1000 families/year (~15,500 families at 16) with the lemma/family ratio rising from 1.4 (10k families) to 2.1 (Brysbaert 20-year-old: 42,000 lemmas vs ~20,000 families); approximate","url":"https://www.lextutor.ca/research/nation_waring_97.html"},{"id":"adult20","size":42000,"label":"Average 20-year-old native adult","labelRu":"Средний взрослый (20 лет)","emoji":"🧑","group":"native","range":[27100,51700],"approximate":false,"source":"Brysbaert, Stevens, Mandera & Keuleers (2016), Frontiers in Psychology 7:1116, Table 4: median 42,000 lemmas, 5th-95th percentile 27,100-51,700 (list of 61,800 lemmas; 11,100 base words)","url":"https://doi.org/10.3389/fpsyg.2016.01116"},{"id":"adult60","size":48200,"label":"Average 60-year-old native adult","labelRu":"Взрослый 60 лет","emoji":"🧓","group":"native","range":[35100,56400],"approximate":false,"source":"Brysbaert et al. (2016), Table 4: median 48,200 lemmas, 5th-95th percentile 35,100-56,400","url":"https://doi.org/10.3389/fpsyg.2016.01116"},{"id":"reader95","size":51700,"label":"\"Philosopher\": 95th percentile of 20-year-olds","labelRu":"Философ / начитанный (топ-5%)","emoji":"🧐","group":"fun","range":[51700,56400],"approximate":false,"source":"Brysbaert et al. (2016), Table 4: 95th percentile 51,700 lemmas (20-year-olds); 56,400 = 95th percentile of 60-year-olds. \"Philosopher\" has no measured basis; label attached to the best-supported high benchmark","url":"https://doi.org/10.3389/fpsyg.2016.01116"}],
}

// What the owner "knows in the app" beyond these few seeded words: lemmas
// per 1000-rank band, so the app-only estimate looks like a real collection (~2,100).
export const baselineSrs: number[] = [520, 410, 300, 230, 170, 130, 95, 70, 52, 38, 27, 19, 13, 9, 6, 4, 3, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

// Topic decks of Q&A facts (Markdown). `inReview: false` shows an off chip.
export interface SeedFact {
  front: string
  back: string
  tags?: string[]
  // 'inbox': Claude's proposal, not studied yet.
  plan: Plan | 'inbox'
}

export interface SeedTopic {
  name: string
  newPerDay: number
  inReview: boolean
  facts: SeedFact[]
}

export const topics: SeedTopic[] = [
  {
    name: 'Concurrency',
    newPerDay: 3,
    inReview: true,
    facts: [
      {
        front: 'What is a race condition?',
        back: 'The result depends on thread scheduling: several threads read and modify shared state without synchronization. Classic example — `x++`, which is a **read-modify-write** of three steps, so increments get lost.\n\nFixes: `synchronized`, `Lock`, atomics (CAS), immutability, thread confinement.\n\n[[race condition]] [[data race]]',
        tags: ['revolut'],
        plan: 'due',
      },
      {
        front: 'What is a deadlock and how do you prevent it?',
        back: 'Threads wait for each other in a cycle, forever.\n\nCoffman conditions — break any one of them:\n1. mutual exclusion\n2. hold-and-wait\n3. no preemption\n4. circular wait\n\nMain technique: **consistent lock ordering**:\n\n```java\nvoid transfer(Account a, Account b, long amount) {\n    Account first = a.id() < b.id() ? a : b;\n    Account second = first == a ? b : a;\n    synchronized (first) {\n        synchronized (second) {\n            a.withdraw(amount);\n            b.deposit(amount);\n        }\n    }\n}\n```',
        tags: ['revolut'],
        plan: 'learning',
      },
      {
        front: 'How does `volatile` differ from `synchronized`?',
        back: '`volatile` gives **visibility** and prevents reordering, but no mutual exclusion — good for status flags and publishing a value.\n\n`synchronized` gives mutual exclusion plus visibility via *happens-before*. Needed for compound operations and invariants.\n\nNote: `volatile int x; x++` is **not atomic**.',
        tags: ['revolut'],
        plan: 'new',
      },
      {
        front: 'What does `ConcurrentHashMap.computeIfAbsent` guarantee?',
        back: 'The mapping function runs **at most once per key**, atomically: other threads asking for the same key wait.\n\nKeep the function short and never touch the same map inside it — that can deadlock.',
        tags: ['notes'],
        plan: 'inbox',
      },
      {
        front: 'What is a `CountDownLatch` for?',
        back: 'One-shot gate: threads `await()` until the count reaches zero via `countDown()`. Can\'t be reset — use `CyclicBarrier` for repeated rounds.',
        tags: ['notes'],
        plan: 'inbox',
      },
      {
        front: 'How does livelock differ from deadlock?',
        back: 'Deadlock — threads are **stuck** (BLOCKED/WAITING), CPU is low, visible in a thread dump.\n\nLivelock — threads are RUNNABLE, **CPU is burning**, but nothing progresses: they keep reacting to each other.\n\nFix: randomized backoff / jitter.',
        tags: ['revolut'],
        plan: 'new',
      },
    ],
  },
  {
    name: 'Java Core',
    newPerDay: 2,
    inReview: true,
    facts: [
      {
        front: 'What is the contract between `equals` and `hashCode`?',
        back: 'Equal objects **must** have equal hash codes; unequal objects may collide.\n\n- override both or neither\n- use the same fields in both\n- keep them stable while the object is a key in a `HashMap`\n\n```java\n@Override public int hashCode() {\n    return Objects.hash(id, email);\n}\n```',
        tags: ['revolut'],
        plan: 'later',
      },
      {
        front: 'What happens when a `HashMap` bucket gets too long?',
        back: 'Since Java 8 a bucket with more than 8 entries (and a table of at least 64) turns into a **red-black tree**: lookups go from O(n) to O(log n). It turns back into a list below 6.',
        tags: ['revolut'],
        plan: 'due',
      },
      {
        front: 'Checked vs unchecked exceptions?',
        back: '*Checked* (`Exception` but not `RuntimeException`) must be declared or caught — recoverable conditions, e.g. `IOException`.\n\n*Unchecked* (`RuntimeException`, `Error`) — programming errors, e.g. `NullPointerException`.',
        tags: ['revolut'],
        plan: 'new',
      },
    ],
  },
  {
    name: 'Databases',
    newPerDay: 3,
    inReview: false,
    facts: [
      {
        front: 'How does a phantom read differ from a non-repeatable read?',
        back: '**Non-repeatable** — the contents of a row you already read changed (UPDATE + COMMIT between your reads).\n\n**Phantom** — the *set* of rows matching a predicate changed (INSERT/DELETE).\n\n[[Non-Repeatable Read]] · [[Phantom Read]]',
        tags: ['revolut'],
        plan: 'due',
      },
      {
        front: 'How do you size a connection pool?',
        back: '**Bigger is not better**: roughly `cores × 2 + spindles` active connections — dozens, not hundreds. Total across instances must stay under `max_connections`, otherwise put PgBouncer in front.',
        tags: ['revolut'],
        plan: 'new',
      },
    ],
  },
]

// A few items of the irregular-verbs pack (server/data/packs), for the
// Packs row in Settings and the forms on verb cards.
export interface SeedVerb {
  verb: string
  past: string[]
  participle: string[]
  translation: string
  example: { text: string; translation: string }
  note: string | null
}

export const irregularVerbs: SeedVerb[] = [
  { verb: 'be', past: ['was', 'were'], participle: ['been'], translation: 'быть, находиться', example: { text: 'We were at home all evening.', translation: 'Мы весь вечер были дома.' }, note: 'was — с I/he/she/it, were — с you/we/they' },
  { verb: 'get', past: ['got'], participle: ['gotten', 'got'], translation: 'получать, становиться', example: { text: 'She has gotten much better at chess.', translation: 'Она стала гораздо лучше играть в шахматы.' }, note: 'gotten — американский вариант, got — британский' },
  { verb: 'give', past: ['gave'], participle: ['given'], translation: 'давать', example: { text: 'He gave me his old bike.', translation: 'Он отдал мне свой старый велосипед.' }, note: null },
  { verb: 'begin', past: ['began'], participle: ['begun'], translation: 'начинать', example: { text: 'The film had already begun when we arrived.', translation: 'Фильм уже начался, когда мы пришли.' }, note: null },
  { verb: 'learn', past: ['learned', 'learnt'], participle: ['learned', 'learnt'], translation: 'учить, узнавать', example: { text: 'I learned to swim when I was six.', translation: 'Я научился плавать в шесть лет.' }, note: 'learnt — британский вариант' },
  { verb: 'strive', past: ['strove', 'strived'], participle: ['striven', 'strived'], translation: 'стремиться', example: { text: 'We strive to answer every email.', translation: 'Мы стараемся отвечать на каждое письмо.' }, note: null },
]
