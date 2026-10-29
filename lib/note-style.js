export const NOTE_STYLE_PROMPT = `You write internal interaction notes for YourOrg, a small organisation (describe what you do here). Write like an experienced operations manager: plain, specific, factual. Rules:
1. State facts plainly. No significance inflation (pivotal, crucial, landscape, underscores, testament, evolving).
2. No arts-sector buzzwords (transformative, empowering, amplifying voices, catalysing change, co-creation, holding space, vibrant). Name the actual activity instead.
3. No promotional adjectives (groundbreaking, renowned, remarkable, profound, stunning).
4. No -ing filler clauses (highlighting…, reflecting…, underscoring…). Write a separate sentence or cut.
5. Use 'is/are', not 'serves as / stands as / represents'.
6. No negative parallelism (not only… but also; not X but Y). Say what it is.
7. No forced lists of three. List only what actually happened.
8. Pick one term for a person or group and keep it. No synonym cycling.
9. No filler (in order to, due to the fact that, it is important to note).
10. No vague attributions (experts say, it is widely acknowledged).
11. Use 'through' not 'via', 'associated with' not 'linked to', 'in addition to' not 'beyond'.
12. Don't restate YourOrg's mission. The reader already knows it.
13. No generic endings. End the summary on the concrete outcome. The next step belongs in tasks, not in the summary.
14. Never use the em dash character (—). Use commas, parentheses or full stops.
15. Keep every name, date, venue, organisation and amount exactly as in the source. Never invent detail. If the source is vague, stay vague; don't pad it.

Always write in English. If the source is in another language, translate the meaning accurately into plain English. Keep proper names, organisation names, titles of artworks/exhibitions and place names in their original form (transliterate Cyrillic names using the spelling the contact uses in their own email signature or address, if visible). If a term has no clean English equivalent (e.g. a Swiss legal or funding term like 'Leistungsvereinbarung'), give the English meaning followed by the original term in parentheses once.`;

export const BANNED_TERMS = [
  'pivotal',
  'crucial',
  'landscape',
  'underscore',
  'testament',
  'transformative',
  'empowering',
  'vibrant',
  'groundbreaking',
  'renowned',
  'remarkable',
  'serves as',
  'stands as',
  'not only',
  'in order to',
  'it is important to note',
  'additionally'
];

function noteStructureRules({ title = false, meeting = false } = {}) {
  const subject = meeting ? 'meeting' : 'email thread';
  const titleLine = title
    ? `- title: four or five words on what the ${subject} was about.\n`
    : '- title: an empty string.\n';
  return `Structure of the note:
${titleLine}- summary: one paragraph of at most 5 sentences. Cover the context, what was discussed, and the outcome. Do not mention action items, who will do them, or their deadlines. Those belong only in tasks.
- tasks: action items only, as a short list. Each item has text and an owner when the source names one. Use an empty string for owner when nobody was named. Use an empty array when there are no action items.
- sourceLanguage: ISO 639-1 code of the main source language (for example de, fr, uk, ru, en). If the source mixes languages, set sourceLanguage to the main one and still write the note in English.
Return these fields as JSON.`;
}

export function noteSystemPrompt(options = {}) {
  return `${NOTE_STYLE_PROMPT}\n\n${noteStructureRules(options)}`;
}

/* Four or five words for a meeting list. Fewer than `min` means there is no title yet. */
export function meetingTitle(value, { min = 4, max = 5 } = {}) {
  const generic = new Set(['granola', 'meeting', 'untitled', 'note', 'notes', 'sync', 'call']);
  const words = String(value || '')
    .replace(/[#*_`]/g, ' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < min) return '';
  const chosen = words.slice(0, max);
  if (chosen.every((word) => generic.has(word.toLowerCase()))) return '';
  return chosen.join(' ');
}

export function replaceEmDashes(text) {
  let out = String(text || '');
  out = out.replace(/\s*\u2014\s*(?=\p{Lu})/gu, '. ');
  out = out.replace(/\s*\u2014\s*/g, ', ');
  out = out.replace(/[ ]{2,}/g, ' ');
  return out.trim();
}

export function findBannedTerms(text) {
  const hay = String(text || '').toLowerCase();
  return BANNED_TERMS.filter((term) => hay.includes(term.toLowerCase()));
}

/* Count a terminator only when the next clause starts a new sentence.
   Periods inside amounts (CHF 12.5) are not boundaries. */
export function capSentences(text, max = 5) {
  const value = String(text || '').trim();
  if (!value) return '';
  const ends = [];
  for (let i = 0; i < value.length; i += 1) {
    if (!'.!?'.includes(value[i])) continue;
    const next = value.slice(i + 1);
    if (/^\d/.test(next)) continue;
    if (next === '' || /^\s+\p{Lu}/u.test(next)) ends.push(i);
  }
  if (ends.length <= max) return value;
  return value.slice(0, ends[max - 1] + 1).trim();
}

export function parseModelJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Model did not return JSON');
    return JSON.parse(body.slice(start, end + 1));
  }
}

const LANGUAGE = /^[a-z]{2,3}$/;

export function validateNote(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Note JSON was not an object');
  }
  const summary = String(raw.summary || '').trim();
  if (!summary) throw new Error('Note summary was empty');
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const cleanTasks = tasks.map((item) => ({
    text: String(item?.text || '').trim().slice(0, 500),
    owner: String(item?.owner || '').trim().slice(0, 120)
  })).filter((item) => item.text).slice(0, 12);
  let sourceLanguage = String(raw.sourceLanguage || '').trim().toLowerCase();
  if (!LANGUAGE.test(sourceLanguage)) sourceLanguage = '';
  return {
    summary,
    tasks: cleanTasks,
    sourceLanguage,
    title: meetingTitle(raw.title)
  };
}

/* The actions list shows the follow-up. Drop a summary sentence that repeats a task. */
export function summaryWithoutTasks(summary, tasks) {
  const items = (tasks || [])
    .map((task) => String(task?.text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim())
    .filter((text) => text.split(' ').length >= 4);
  if (!items.length) return String(summary || '').trim();
  const kept = String(summary || '').split(/(?<=[.!?])\s+/).filter((sentence) => {
    const norm = sentence.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (norm.split(' ').length < 4) return true;
    return !items.some((task) => norm.includes(task) || task.includes(norm));
  });
  const next = kept.join(' ').trim();
  return next || String(summary || '').trim();
}

function applyStyle(note) {
  return {
    summary: capSentences(replaceEmDashes(summaryWithoutTasks(note.summary, note.tasks))),
    tasks: note.tasks.map((task) => ({
      text: replaceEmDashes(task.text),
      owner: replaceEmDashes(task.owner)
    })),
    sourceLanguage: note.sourceLanguage,
    title: meetingTitle(note.title)
  };
}

function notePlain(note) {
  return [note.summary, ...note.tasks.map((task) => task.text)].join('\n');
}

/* A copied Granola outline is headings and bullets, not the one-paragraph summary. */
export function copiesSourceLayout(text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  const bullet = (line) => /^([-*•]|\d+[.)])\s/.test(line);
  if (lines.filter(bullet).length >= 3) return true;
  const headings = lines.filter((line) => line.length < 60 && !/[.!?]$/.test(line) && !bullet(line));
  return headings.length >= 2 && lines.length >= 6;
}

export const NOTE_OUTPUT_CONFIG = {
  format: {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              owner: { type: 'string' }
            },
            required: ['text', 'owner'],
            additionalProperties: false
          }
        },
        sourceLanguage: { type: 'string' }
      },
      required: ['title', 'summary', 'tasks', 'sourceLanguage'],
      additionalProperties: false
    }
  }
};

/* Structured output is a text block. Thinking blocks are skipped. A plain object is already parsed. */
export function noteFromModel(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (Array.isArray(raw.content)) {
      const block = raw.content.find((part) => part?.type === 'text' && typeof part.text === 'string');
      if (!block) throw new Error('Model did not return JSON');
      try {
        const parsed = JSON.parse(block.text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Model did not return JSON');
        }
        return parsed;
      } catch (error) {
        if (error?.message === 'Model did not return JSON') throw error;
        throw new Error('Model did not return JSON');
      }
    }
    if (typeof raw.summary === 'string') return raw;
  }
  return parseModelJson(typeof raw === 'string' ? raw : '');
}

export function noteRequest({ sourceText, context = {}, banned = [], layout = false } = {}) {
  const head = [
    'Write an internal interaction note from the source below.',
    'Read the entire source before writing. Base the outcome on the latest state of the conversation or the end of the meeting, not on early messages. Put every follow-up only in tasks.',
    'The summary and the tasks must be in English.',
    context.contactName ? `Contact: ${context.contactName}` : '',
    context.company ? `Organisation: ${context.company}` : '',
    context.lead ? `YourOrg lead (team id): ${context.lead}` : '',
    banned.length
      ? `The previous draft used banned wording. Remove these terms and do not replace them with synonyms: ${banned.join(', ')}.`
      : '',
    layout
      ? 'The previous draft copied the source headings and bullets. Follow the structure already given: the summary is one paragraph of at most 5 sentences, and action items go only in tasks.'
      : ''
  ].filter(Boolean);
  return {
    system: noteSystemPrompt({ title: true, meeting: Boolean(context.meeting) }),
    user: `${head.join('\n')}\n\nSource:\n${String(sourceText || '').slice(0, 40000)}`,
    maxTokens: 4000,
    output_config: NOTE_OUTPUT_CONFIG
  };
}

export async function writeNote({ sourceText, context, complete }) {
  let first = applyStyle(validateNote(noteFromModel(await complete(noteRequest({ sourceText, context })))));
  if (copiesSourceLayout(first.summary)) {
    first = applyStyle(validateNote(noteFromModel(
      await complete(noteRequest({ sourceText, context, layout: true }))
    )));
    if (copiesSourceLayout(first.summary)) {
      throw new Error('The summary was still the source outline. Try again.');
    }
  }
  const banned = findBannedTerms(notePlain(first));
  if (!banned.length) return { ...first, styleWarning: false };
  try {
    const second = applyStyle(validateNote(noteFromModel(
      await complete(noteRequest({ sourceText, context, banned }))
    )));
    const still = findBannedTerms(notePlain(second));
    return { ...second, styleWarning: still.length > 0 };
  } catch {
    return { ...first, styleWarning: true };
  }
}
