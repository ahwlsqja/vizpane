// Injected into every Claude Code session that runs inside cmux. It carries the rules an agent needs
// even if it never opens the viz-style skill. The Korean paragraph applies only to Korean answers.
export const SESSION_CONTEXT = [
  'vizpane is active: a ```mermaid code block in your answer is rendered as a picture. In Claude Code the picture is drawn inside the conversation, under your answer; in Codex it appears in the side pane next to the terminal.',
  'When an explanation has three or more relationships, branches, boundaries or ordered steps, include one Mermaid diagram. Detailed rules and examples are in the viz-style skill.',
  'Write the diagram body in plain syntax only. flowchart (LR for up to six nodes in a line, TB for longer or branching flows): id["label"], id{"decision"}, id(["end"]), -->, -.->, -->|"label"|. ' +
    'sequenceDiagram: participant/actor ID as Label, ->>, -->>, --x, Note over, alt/else/loop/opt. ' +
    'Do not use subgraph, class, style, ==>, autonumber, box or rect.',
  'Put shapes, colours and grouping in comment lines above the declarations. ' +
    'flowchart: %% viz: stream|store|table|proc|decide|fail|ok|ext <id…> and %% viz: bronze|silver|gold|group <id…> as Title. ' +
    'sequenceDiagram: %% viz: queue|database|control <id…>, %% viz: box <id…> as Title, and a phase between %% viz: phase and %% viz: end. ' +
    '<id…> are the declared identifiers, not labels (for "participant K as Kafka" write K).',
  '한국어로 답할 때는 한국 엔지니어가 실무에서 쓰는 말로 쓴다. 영어 원어로 통하는 기술 용어(offset, checkpoint, backpressure, replication slot, threshold 등)는 번역하지 않고, ' +
    '한국어로 굳은 말(적재, 배포, 장애, 재처리, 모니터링, 알림, 백필)은 그대로 쓴다. 역압력·논리 디코딩·감시·경보 같은 직역과 번역투 문장은 쓰지 않는다.',
  'An answer without a diagram is not shown automatically. If the user asks to show the last answer in the pane, use the viz skill.',
].join('\n');

// Stop payloads of both agents carry the same three fields we need; anything else is ignored.
export function parseHookPayload(agent, obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const md = obj.last_assistant_message;
  if (typeof md !== 'string' || !md.trim()) return null;
  return {
    agent,
    session: typeof obj.session_id === 'string' && obj.session_id ? obj.session_id : 'unknown',
    cwd: typeof obj.cwd === 'string' ? obj.cwd : '',
    markdown: md,
  };
}
