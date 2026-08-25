import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { applyTheme, loadTheme } from './theme.js';

// 在 render 之前套用，否则会先闪一下默认的紫色再跳成选中的那套
applyTheme(loadTheme());

createRoot(document.getElementById('root')).render(<App />);
