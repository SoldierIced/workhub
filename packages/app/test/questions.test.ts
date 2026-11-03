import { describe, expect, it } from 'vitest'
import type { AgentQuestion } from '@workhub/core'
import { answersSummary, EMPTY_PICK, questionAnswers, togglePick, typeOther } from '../src/renderer/lib/questions'
import { applyEvent, withdrawOpenRequests, type SessionData } from '../src/renderer/store'
import { awaitingAnswer } from '../src/renderer/store'

const color: AgentQuestion = { question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] }
const extras: AgentQuestion = { question: 'Extras?', header: 'Extras', options: [{ label: 'Cream' }, { label: 'Nuts' }], multiSelect: true }

describe('question answers', () => {
  it('keeps one option on a single-answer question and lets typed words replace it', () => {
    let pick = togglePick(EMPTY_PICK, 'Red', false)
    pick = togglePick(pick, 'Blue', false)
    expect(pick).toEqual({ labels: ['Blue'], other: '' })
    expect(typeOther(pick, 'Green', false)).toEqual({ labels: [], other: 'Green' })
    expect(togglePick({ labels: [], other: 'Green' }, 'Red', false)).toEqual({ labels: ['Red'], other: '' })
  })

  it('toggles options on a multi-select and adds the typed words, in the options\' order', () => {
    let pick = togglePick(EMPTY_PICK, 'Nuts', true)
    pick = togglePick(pick, 'Cream', true)
    pick = typeOther(pick, ' Sprinkles ', true)
    expect(questionAnswers([extras], [pick])).toEqual({ 'Extras?': 'Cream, Nuts, Sprinkles' })
    expect(togglePick(pick, 'Nuts', true).labels).toEqual(['Cream'])
  })

  it('sends nothing until every question has an answer, and sums them up in one line', () => {
    expect(questionAnswers([color, extras], [togglePick(EMPTY_PICK, 'Blue', false), EMPTY_PICK])).toBeNull()
    const answers = questionAnswers([color, extras], [togglePick(EMPTY_PICK, 'Blue', false), typeOther(EMPTY_PICK, 'None', true)])
    expect(answers).toEqual({ 'Which color?': 'Blue', 'Extras?': 'None' })
    expect(answersSummary([color, extras], answers!)).toBe('Color: Blue · Extras: None')
    expect(answersSummary([color], { 'Which color?': 'Red' })).toBe('Red')
  })
})

describe('open requests when the chat ends', () => {
  it('withdraws unanswered questions so the session stops waiting for an answer', () => {
    const empty = { view: {} as SessionData['view'], items: [], monitor: {} } as SessionData
    let n = 0
    const asked = applyEvent(empty, { sessionId: 's', type: 'permission', requestId: 'p1', title: 'Asked you a question', options: [], questions: [color] }, () => ++n)
    expect(awaitingAnswer(asked)).toBe(true)
    const after = withdrawOpenRequests(asked)
    expect(awaitingAnswer(after)).toBe(false)
    expect(after.items[0]).toMatchObject({ kind: 'permission', answer: '—' })
    expect(withdrawOpenRequests(after)).toBe(after)
  })
})
