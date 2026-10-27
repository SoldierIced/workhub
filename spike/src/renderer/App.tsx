import { useState } from 'react'
import { AcpTab } from './AcpTab'
import { TerminalTab } from './TerminalTab'

type Tab = 'terminal' | 'acp'

export function App() {
  const [tab, setTab] = useState<Tab>('terminal')
  // Both tabs stay mounted so the shell and the agent session survive tab switches.
  return (
    <>
      <div className="tabs">
        <button className={tab === 'terminal' ? 'active' : ''} onClick={() => setTab('terminal')}>
          Terminal
        </button>
        <button className={tab === 'acp' ? 'active' : ''} onClick={() => setTab('acp')}>
          ACP chat
        </button>
      </div>
      <div className={`pane ${tab === 'terminal' ? '' : 'hidden'}`}>
        <TerminalTab visible={tab === 'terminal'} />
      </div>
      <div className={`pane ${tab === 'acp' ? '' : 'hidden'}`}>
        <AcpTab />
      </div>
    </>
  )
}
