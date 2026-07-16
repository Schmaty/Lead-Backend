import type { ReactNode } from 'react'
import AuthView from './views/Auth'
import Shell from './components/Shell'
import { useDesk } from './store'
import { C, shimmer } from './styles'

export default function App(): ReactNode {
  const { st } = useDesk()
  if (st.booting) {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 'min(420px, 80vw)', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={shimmer(44)} />
          <div style={shimmer(14, { width: '60%' })} />
          <div style={shimmer(14, { width: '80%' })} />
        </div>
      </div>
    )
  }
  if (!st.user) return <AuthView />
  return <Shell />
}
