import assert from 'node:assert/strict';
import test from 'node:test';
import { writeNote } from './note-style.js';

function modelReply(note) {
  return {
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: 'Consider the source, then answer.' },
      { type: 'text', text: JSON.stringify(note) }
    ]
  };
}

test('a follow-up repeated in the summary is left to the task list', async () => {
  const note = await writeNote({
    sourceText: 'Morgan was interviewed. Alex will send feedback by 13 October 2026.',
    context: { meeting: true, contactName: 'Morgan Reed' },
    complete: async () => modelReply({
      title: 'Programme coordinator interview Morgan',
      summary: 'Alex and Sam interviewed Morgan Reed for the programme coordinator role. Send feedback to all Programme Coordinator candidates by the end of the week (13 October 2026).',
      tasks: [{
        text: 'Send feedback to all Programme Coordinator candidates by the end of the week (13 October 2026)',
        owner: 'Alex'
      }],
      sourceLanguage: 'en'
    })
  });
  assert.match(note.summary, /interviewed Morgan Reed/);
  assert.doesNotMatch(note.summary, /Send feedback/);
  assert.match(note.tasks[0].text, /Send feedback/);
});

test('em dash is removed in post-processing', async () => {
  const note = await writeNote({
    sourceText: 'Ada confirmed the loan.',
    context: { contactName: 'Ada' },
    complete: async () => modelReply({
      title: '',
      summary: 'Ada confirmed the loan — She will send it on 2 June 2026.',
      tasks: [{ text: 'File the receipt — Tomorrow', owner: '' }],
      sourceLanguage: 'en'
    })
  });
  assert.equal(note.title, '');
  assert.equal(note.summary.includes('\u2014'), false);
  assert.equal(note.summary, 'Ada confirmed the loan. She will send it on 2 June 2026.');
  assert.equal(note.tasks[0].text.includes('\u2014'), false);
  assert.equal(note.tasks[0].text, 'File the receipt. Tomorrow');
});

test('a banned term triggers one retry', async () => {
  const calls = [];
  const note = await writeNote({
    sourceText: 'We agreed the residency dates.',
    context: { contactName: 'Ada' },
    complete: async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        return modelReply({
          title: '',
          summary: 'This Pivotal residency starts on 1 May 2026.',
          tasks: [],
          sourceLanguage: 'en'
        });
      }
      return modelReply({
        title: '',
        summary: 'The residency starts on 1 May 2026.',
        tasks: [],
        sourceLanguage: 'en'
      });
    }
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1].user, /pivotal/);
  assert.equal(note.styleWarning, false);
  assert.doesNotMatch(note.summary, /pivotal/i);
  assert.match(note.summary, /1 May 2026/);
});

test('names and dates survive post-processing unchanged', async () => {
  const note = await writeNote({
    sourceText: 'On 3 March 2024 Olena Kovalenko confirmed CHF 12000.',
    context: { contactName: 'Olena Kovalenko' },
    complete: async () => modelReply({
      title: '',
      summary: 'On 3 March 2024  Olena Kovalenko — she confirmed CHF 12000.',
      tasks: [{ text: 'Reply by 12 April 2024', owner: 'Olena Kovalenko' }],
      sourceLanguage: 'en'
    })
  });
  assert.equal(note.summary, 'On 3 March 2024 Olena Kovalenko, she confirmed CHF 12000.');
  assert.match(note.summary, /Olena Kovalenko/);
  assert.match(note.summary, /3 March 2024/);
  assert.match(note.summary, /CHF 12000/);
  assert.equal(note.tasks[0].text, 'Reply by 12 April 2024');
  assert.equal(note.tasks[0].owner, 'Olena Kovalenko');
});

test('a German source produces an English note with sourceLanguage de', async () => {
  let seen = null;
  const note = await writeNote({
    sourceText: 'Hallo Alex, das Treffen am 14. Mai 2025 mit Olena Kovalenko in Kyiv ist bestätigt.',
    context: { contactName: 'Olena Kovalenko' },
    complete: async (request) => {
      seen = request;
      return modelReply({
        title: '',
        summary: 'Olena Kovalenko confirmed the meeting in Kyiv on 14 May 2025.',
        tasks: [{ text: 'Send the programme note by 2 June 2025', owner: 'Olena Kovalenko' }],
        sourceLanguage: 'de'
      });
    }
  });
  assert.match(seen.system, /Always write in English/);
  assert.match(seen.user, /Read the entire source before writing/);
  assert.match(seen.user, /14\. Mai 2025/);
  assert.match(seen.user, /Olena Kovalenko/);
  assert.match(seen.user, /Kyiv/);
  assert.equal(note.sourceLanguage, 'de');
  assert.equal(note.summary, 'Olena Kovalenko confirmed the meeting in Kyiv on 14 May 2025.');
  assert.doesNotMatch(note.summary, /bestätigt|Treffen/);
  assert.equal(note.tasks[0].owner, 'Olena Kovalenko');
  assert.equal(note.tasks[0].text, 'Send the programme note by 2 June 2025');
});

test('an email thread gets a four or five word title', async () => {
  let seen = null;
  const note = await writeNote({
    sourceText: 'Olena confirmed the June catalogue by email.',
    context: { meeting: false, contactName: 'Olena Kovalenko' },
    complete: async (request) => {
      seen = request;
      return modelReply({
        title: 'June catalogue dates confirmed now',
        summary: 'Olena Kovalenko confirmed the catalogue for 2 June 2026.',
        tasks: [],
        sourceLanguage: 'en'
      });
    }
  });
  assert.match(seen.system, /four or five words on what the email thread was about/);
  assert.equal(note.title, 'June catalogue dates confirmed now');
});

test('a meeting note gets a four or five word title', async () => {
  let seen = null;
  const note = await writeNote({
    sourceText: 'Enhanced summary: Olena agreed the June catalogue.',
    context: { meeting: true, contactName: 'Olena Kovalenko' },
    complete: async (request) => {
      seen = request;
      return modelReply({
        title: 'June catalogue dates agreed today.',
        summary: 'Olena Kovalenko agreed the catalogue for 2 June 2026.',
        tasks: [],
        sourceLanguage: 'en'
      });
    }
  });
  assert.match(seen.system, /four or five words on what the meeting was about/);
  assert.match(seen.system, /at most 5 sentences/);
  assert.match(seen.system, /Always write in English/);
  assert.doesNotMatch(seen.user, /Base the note on that summary/);
  assert.equal(note.title, 'June catalogue dates agreed today');
  assert.match(note.summary, /2 June 2026/);
});

test('a copied Granola outline is rewritten as a paragraph', async () => {
  const calls = [];
  const note = await writeNote({
    sourceText: '## Candidate background\n\n- Editor of a public program\n- Catalog due in February\n- Travel to Warsaw after Venice',
    context: { meeting: true, contactName: 'Morgan Reed' },
    complete: async (request) => {
      calls.push(request.user);
      if (calls.length === 1) {
        return modelReply({
          title: 'Coordinator interview with Morgan',
          summary: 'Candidate Background\n\n- Editor of a public program\n- Catalog due in February\n- Travel to Warsaw after Venice',
          tasks: [],
          sourceLanguage: 'en'
        });
      }
      return modelReply({
        title: 'Coordinator interview with Morgan',
        summary: 'Morgan Reed is an editor and co-curator. The catalogue enters production for a February deadline. She will travel to Warsaw after Venice.',
        tasks: [{ text: 'Confirm the February catalogue deadline', owner: 'Morgan Reed' }],
        sourceLanguage: 'en'
      });
    }
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /copied the source headings and bullets/);
  assert.equal(note.title, 'Coordinator interview with Morgan');
  assert.doesNotMatch(note.summary, /^\s*-/m);
  assert.match(note.summary, /February/);
});

test('a text block is the note, and the request asks for a json schema', async () => {
  let seen = null;
  const note = await writeNote({
    sourceText: 'Olena agreed the catalogue on 2 June 2026.',
    context: { meeting: true, contactName: 'Olena Kovalenko' },
    complete: async (request) => {
      seen = request;
      return modelReply({
        title: 'June catalogue dates agreed',
        summary: 'Olena Kovalenko agreed the catalogue on 2 June 2026.',
        tasks: [{ text: 'Send the checklist', owner: 'Olena Kovalenko' }],
        sourceLanguage: 'en'
      });
    }
  });
  const schema = seen.output_config.format.schema;
  assert.equal(seen.maxTokens, 4000);
  assert.equal(seen.tools, undefined);
  assert.equal(seen.toolChoice, undefined);
  assert.equal(seen.output_config.format.type, 'json_schema');
  assert.deepEqual(schema.required, ['title', 'summary', 'tasks', 'sourceLanguage']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.tasks.items.required, ['text', 'owner']);
  assert.equal(schema.properties.tasks.items.additionalProperties, false);
  assert.equal(schema.properties.relevant, undefined);
  assert.doesNotMatch(JSON.stringify(schema), /minLength|maxLength|minimum/);
  assert.equal(note.title, 'June catalogue dates agreed');
  assert.equal(note.summary, 'Olena Kovalenko agreed the catalogue on 2 June 2026.');
  assert.equal(note.tasks[0].text, 'Send the checklist');
  assert.equal(note.tasks[0].owner, 'Olena Kovalenko');
});
