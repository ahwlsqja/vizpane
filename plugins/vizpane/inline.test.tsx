import { expect, test } from 'claude-code/testing'

const FLOW = 'flowchart LR\n  A --> B'
const reply = (...parts: string[]) => parts.join('\n')

// Engine stand-ins for what the mod asks of $: the helper builds, measures and renders; the cache is empty.
function engine(on: any, seen: { lead: string[] }) {
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/h' : e.name === 'LANG' ? 'ko_KR.UTF-8' : undefined }))
  on('config.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: '{}' }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', (_: any, e: any) => {
    const argv = e.argv as string[]
    const out = argv.includes('renderer') ? '{"ok":true,"path":"/h/viz-render"}'
      : argv.includes('--cell') ? '{"ok":true,"cellWidth":8,"cellAspect":2,"columns":120,"rows":40}'
      : argv[0] === '/h/viz-render' ? '{"ok":true,"width":400,"height":200}' : ''
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // The engine's own row for the text it is given: record it.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    seen.lead.push(`${e.props.text}|first=${e.props.isFirstOfReply}`)
    return <Text>engine:{e.props.text}</Text>
  })
}

test('a picture is drawn where its block was, between the text around it', async ($, on) => {
  const seen = { lead: [] as string[] }
  engine(on, seen)
  const text = reply('Before the diagram.', '', '```mermaid', FLOW, '```', '', 'After the diagram.', '', '```mermaid', 'flowchart TB\n  X --> Y', '```', '', 'The end.')
  const ui = await $.ui.mount({ plugin: 'vizpane', surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true } } as any)
  expect(seen.lead).toEqual(['Before the diagram.|first=true'])
  const lead = await ui.find({ type: 'Text', text: /engine:Before the diagram\./ })
  expect(lead).toBeTruthy()
  const after = await ui.find({ type: 'Markdown', text: /After the diagram\./ })
  expect(after).toBeTruthy()
  const end = await ui.find({ type: 'Markdown', text: /The end\./ })
  expect(end).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'viz-more-0' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'viz-more-1' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /도식 1/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /도식 2/ })).toBeTruthy()
  expect(await ui.find({ type: 'Markdown', text: /mermaid/ })).toBeFalsy()
  await ui.unmount()
})

test('a reply that opens with a diagram keeps its bullet on a short first row', async ($, on) => {
  const seen = { lead: [] as string[] }
  engine(on, seen)
  const text = reply('```mermaid', FLOW, '```', '', 'Then the words.')
  const ui = await $.ui.mount({ plugin: 'vizpane', surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true } } as any)
  expect(seen.lead).toEqual(['도식 1|first=true'])
  expect(await ui.find({ type: 'Markdown', text: /Then the words\./ })).toBeTruthy()
  await ui.unmount()
})

test('a reply without a diagram is left to the engine', async ($, on) => {
  const seen = { lead: [] as string[] }
  engine(on, seen)
  const ui = await $.ui.mount({ plugin: 'vizpane', surface: 'terminal', component: 'AssistantMessage', props: { text: 'plain words', isFirstOfReply: true } } as any)
  expect(seen.lead).toEqual(['plain words|first=true'])
  expect(await ui.find({ type: 'Text', text: /engine:plain words/ })).toBeTruthy()
  expect(await ui.find({ type: 'Markdown' })).toBeFalsy()
  await ui.unmount()
})
