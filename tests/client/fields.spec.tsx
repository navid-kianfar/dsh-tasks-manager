/**
 * The card detail's fields, mounted the way a browser mounts them.
 *
 * Three of them open a surface portalled to `document.body`, so assertions look there rather than
 * inside the mounted container — which is exactly the clipping the portal exists to escape.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'
import { AssigneePicker, assigneeRows, initialsOf } from '../../src/client/board/AssigneePicker.tsx'
import { ConfirmDialog } from '../../src/client/board/ConfirmDialog.tsx'
import { DatePicker } from '../../src/client/board/DatePicker.tsx'
import { placeSurface } from '../../src/client/board/Popover.tsx'
import { Select } from '../../src/client/board/Select.tsx'
import { TagInput, canonicalLabel } from '../../src/client/board/TagInput.tsx'
import type { BoardTranslate } from '../../src/client/board/contract.ts'

/** React 18 checks this before it will run effects in a test environment. */
declare global {
  // eslint-disable-next-line no-var -- the flag React reads is a global var, not a property.
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** Echoes the key, so an assertion names the dictionary entry rather than a translation. */
const t: BoardTranslate = key => key

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = undefined
  host = undefined
})

/**
 * Mount one field.
 * @param node - the element to render.
 * @returns the mounted container; portalled surfaces land on `document.body`.
 */
function render(node: ReactNode): HTMLElement {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root?.render(node) })
  return host
}

/**
 * Every button on the page, mounted or portalled.
 * @returns the buttons.
 */
function buttons(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll('button')]
}

/**
 * Type into a controlled input the way a person does.
 *
 * Assigning `.value` directly is invisible to React: it tracks the last value it wrote on the node
 * and skips the change as a no-op. Going through the prototype's own setter defeats that tracker,
 * which is what every React testing library does here.
 * @param box - the input to type into.
 * @param text - the text to leave in it.
 */
function type(box: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/**
 * Click the first button whose text matches.
 * @param text - the text to look for.
 */
function click(text: string): void {
  const target = buttons().find(node => node.textContent?.includes(text))
    ?? buttons().find(node => node.getAttribute('aria-label') === text)
  act(() => { target?.click() })
}

describe('Select', () => {
  it('shows the chosen option and offers the rest', () => {
    render(
      <Select
        value="todo"
        options={[
          { value: 'todo', label: 'To do', status: 'todo' },
          { value: 'done', label: 'Done', status: 'done' },
        ]}
        label="Status"
        onChange={vi.fn()}
      />,
    )
    const trigger = document.body.querySelector<HTMLButtonElement>('button[aria-label="Status"]')
    expect(trigger?.textContent).toContain('To do')
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')

    act(() => { trigger?.click() })
    expect(document.body.querySelector('[role="menu"]')?.textContent).toContain('Done')
  })

  it('commits the row that was clicked and closes', () => {
    const onChange = vi.fn()
    render(
      <Select
        value="todo"
        options={[{ value: 'todo', label: 'To do' }, { value: 'done', label: 'Done' }]}
        label="Status"
        onChange={onChange}
      />,
    )
    click('Status')
    click('Done')

    expect(onChange).toHaveBeenCalledWith('done')
    expect(document.body.querySelector('button[aria-label="Status"]')?.getAttribute('aria-expanded'))
      .toBe('false')
  })

  it('does not write back the value already chosen', () => {
    const onChange = vi.fn()
    render(
      <Select
        value="todo"
        options={[{ value: 'todo', label: 'To do' }, { value: 'done', label: 'Done' }]}
        label="Status"
        onChange={onChange}
      />,
    )
    click('Status')
    click('To do')

    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('DatePicker', () => {
  /** A fixed instant, so "today" and the opening month never depend on when the suite runs. */
  const now = Date.UTC(2026, 2, 9, 12)

  it('reads as its placeholder while the card has no due date', () => {
    render(<DatePicker value={undefined} onChange={vi.fn()} label="Due" placeholder="No due date" now={now} t={t} />)
    expect(document.body.querySelector('button[aria-label="Due"]')?.textContent).toContain('No due date')
  })

  it('opens a month of the chosen day and commits the cell that was clicked', () => {
    const onChange = vi.fn()
    render(<DatePicker value="2026-03-09" onChange={onChange} label="Due" placeholder="No due date" now={now} t={t} />)
    click('Due')

    const grid = document.body.querySelector('[role="grid"]')
    expect(grid).not.toBeNull()
    expect(grid?.querySelector('[data-date="2026-03-09"]')?.getAttribute('aria-selected')).toBe('true')

    act(() => { grid?.querySelector<HTMLButtonElement>('[data-date="2026-03-17"]')?.click() })
    expect(onChange).toHaveBeenCalledWith('2026-03-17')
    expect(document.body.querySelector('[role="grid"]')).toBeNull()
  })

  it('marks today even when a different day is chosen', () => {
    render(<DatePicker value="2026-03-17" onChange={vi.fn()} label="Due" placeholder="No due date" now={now} t={t} />)
    click('Due')

    const grid = document.body.querySelector('[role="grid"]')
    expect(grid?.querySelector('[data-date="2026-03-09"]')?.getAttribute('aria-current')).toBe('date')
    expect(grid?.querySelector('[data-date="2026-03-17"]')?.getAttribute('aria-selected')).toBe('true')
  })

  it('pages between months without committing anything', () => {
    const onChange = vi.fn()
    render(<DatePicker value="2026-03-09" onChange={onChange} label="Due" placeholder="No due date" now={now} t={t} />)
    click('Due')
    click('date.nextMonth')

    expect(document.body.querySelector('[role="grid"] [data-date="2026-04-15"]')).not.toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('clears the date from the field without opening the calendar', () => {
    const onChange = vi.fn()
    render(<DatePicker value="2026-03-09" onChange={onChange} label="Due" placeholder="No due date" now={now} t={t} />)
    click('date.clear')

    expect(onChange).toHaveBeenCalledWith('')
    expect(document.body.querySelector('[role="grid"]')).toBeNull()
  })
})

describe('AssigneePicker', () => {
  const authors = [
    { name: 'Ada', email: 'ada@example.com', commits: 12, self: true },
    { name: 'Grace', email: 'grace@example.com', commits: 3 },
  ]

  it('offers only the project’s committers, with the configured identity marked', () => {
    render(
      <AssigneePicker value={undefined} authors={authors} available onChange={vi.fn()} label="Assignee" t={t} />,
    )
    click('Assignee')

    const list = document.body.querySelector('[role="listbox"]')
    expect(list?.textContent).toContain('Ada')
    expect(list?.textContent).toContain('grace@example.com')
    expect(list?.textContent).toContain('detail.assigneeYou')
  })

  it('commits the person that was clicked', () => {
    const onChange = vi.fn()
    render(
      <AssigneePicker value={undefined} authors={authors} available onChange={onChange} label="Assignee" t={t} />,
    )
    click('Assignee')
    click('Grace')

    expect(onChange).toHaveBeenCalledWith('Grace')
  })

  it('explains an empty roster rather than showing an empty list', () => {
    render(
      <AssigneePicker value={undefined} authors={[]} available={false} onChange={vi.fn()} label="Assignee" t={t} />,
    )
    click('Assignee')

    expect(document.body.textContent).toContain('detail.assigneeNoGit')
  })

  it('keeps a value the history does not know rather than dropping it', () => {
    const rows = assigneeRows(authors, 'someone-else', '')
    expect(rows[0]).toMatchObject({ value: 'someone-else', unknown: true })
    expect(rows).toHaveLength(3)
  })

  it('filters on both name and address', () => {
    expect(assigneeRows(authors, undefined, 'gra').map(row => row.name)).toEqual(['Grace'])
    expect(assigneeRows(authors, undefined, 'ada@').map(row => row.name)).toEqual(['Ada'])
    expect(assigneeRows(authors, undefined, 'nobody')).toEqual([])
  })

  it('draws initials from a name, an address, or neither', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL')
    expect(initialsOf('ada')).toBe('AD')
    expect(initialsOf('ada@example.com')).toBe('AE')
    expect(initialsOf('   ')).toBe('?')
  })
})

describe('TagInput', () => {
  it('canonicalises a label the way the store will', () => {
    expect(canonicalLabel('  API   Gateway ')).toBe('api gateway')
    expect(canonicalLabel('   ')).toBe('')
    expect(canonicalLabel('x'.repeat(60))).toHaveLength(40)
  })

  it('draws one chip per label', () => {
    render(
      <TagInput value={['api', 'security']} suggestions={[]} onChange={vi.fn()} label="Labels" placeholder="Add" t={t} />,
    )
    expect(host?.textContent).toContain('api')
    expect(host?.textContent).toContain('security')
  })

  it('adds a typed label on Enter', () => {
    const onChange = vi.fn()
    render(
      <TagInput value={['api']} suggestions={[]} onChange={onChange} label="Labels" placeholder="Add" t={t} />,
    )
    const box = host?.querySelector<HTMLInputElement>('input[aria-label="Labels"]') as HTMLInputElement
    type(box, ' Security ')
    act(() => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })

    expect(onChange).toHaveBeenCalledWith(['api', 'security'])
  })

  it('refuses a duplicate rather than writing the same label twice', () => {
    const onChange = vi.fn()
    render(
      <TagInput value={['api']} suggestions={[]} onChange={onChange} label="Labels" placeholder="Add" t={t} />,
    )
    const box = host?.querySelector<HTMLInputElement>('input[aria-label="Labels"]') as HTMLInputElement
    type(box, 'API')
    act(() => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })

    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes the chip whose cross is clicked', () => {
    const onChange = vi.fn()
    render(
      <TagInput value={['api', 'security']} suggestions={[]} onChange={onChange} label="Labels" placeholder="Add" t={t} />,
    )
    click('detail.labelRemove')

    expect(onChange).toHaveBeenCalledWith(['security'])
  })

  it('backspaces the last chip out of an empty box', () => {
    const onChange = vi.fn()
    render(
      <TagInput value={['api', 'security']} suggestions={[]} onChange={onChange} label="Labels" placeholder="Add" t={t} />,
    )
    const box = host?.querySelector<HTMLInputElement>('input[aria-label="Labels"]') as HTMLInputElement
    act(() => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })) })

    expect(onChange).toHaveBeenCalledWith(['api'])
  })

  it('suggests labels already on the board, minus the ones this card carries', () => {
    render(
      <TagInput
        value={['api']}
        suggestions={['api', 'security', 'infra']}
        onChange={vi.fn()}
        label="Labels"
        placeholder="Add"
        t={t}
      />,
    )
    const box = host?.querySelector<HTMLInputElement>('input[aria-label="Labels"]') as HTMLInputElement
    act(() => { box.dispatchEvent(new FocusEvent('focus', { bubbles: true })); box.focus() })

    const surface = document.body.querySelector('[role="dialog"]')
    expect(surface?.textContent).toContain('security')
    expect(surface?.textContent).toContain('infra')
    expect(surface?.textContent).not.toContain('api')

    type(box, 'inf')
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toBe('infra')
  })
})

describe('ConfirmDialog', () => {
  it('shows nothing until something is being asked', () => {
    render(<ConfirmDialog request={null} onClose={vi.fn()} cancelLabel="Cancel" closeLabel="Close" />)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('states what is about to happen and runs it only on the confirming press', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(
      <ConfirmDialog
        request={{
          title: 'Delete task #7?',
          description: 'This cannot be undone.',
          confirmLabel: 'Delete permanently',
          onConfirm,
        }}
        onClose={onClose}
        cancelLabel="Cancel"
        closeLabel="Close"
      />,
    )
    expect(document.body.textContent).toContain('Delete task #7?')
    expect(document.body.textContent).toContain('This cannot be undone.')

    click('Cancel')
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()

    click('Delete permanently')
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

describe('placeSurface', () => {
  const viewport = { width: 1000, height: 800 }

  it('sits under the anchor when there is room', () => {
    const at = placeSurface({ left: 100, right: 300, top: 100, bottom: 130 }, { width: 200, height: 200 }, viewport, 'start')
    expect(at.left).toBe(100)
    expect(at.top).toBe(134)
  })

  it('flips above the anchor when below cannot hold it and above can', () => {
    const at = placeSurface({ left: 100, right: 300, top: 600, bottom: 630 }, { width: 200, height: 300 }, viewport, 'start')
    expect(at.top).toBe(296)
  })

  it('stays below when neither side fits, rather than trading for a smaller box', () => {
    const at = placeSurface({ left: 0, right: 200, top: 300, bottom: 330 }, { width: 200, height: 600 }, viewport, 'start')
    expect(at.top).toBe(334)
  })

  it('keeps the surface inside the viewport', () => {
    const at = placeSurface({ left: 950, right: 990, top: 10, bottom: 40 }, { width: 300, height: 100 }, viewport, 'start')
    expect(at.left).toBe(692)
  })

  it('lines the surface up with the anchor’s trailing edge when asked', () => {
    const at = placeSurface({ left: 400, right: 600, top: 10, bottom: 40 }, { width: 300, height: 100 }, viewport, 'end')
    expect(at.left).toBe(300)
  })
})
