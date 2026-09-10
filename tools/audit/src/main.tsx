import { createRoot } from 'react-dom/client';
import { AuditChecklist } from './features/audit/AuditChecklist';
import './styles.css';
createRoot(document.getElementById('root')!).render(<AuditChecklist />);
