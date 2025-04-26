import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

// Получаем корневой DOM-элемент
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Failed to find the root element');

// Создаем корневой React-узел
const root = ReactDOM.createRoot(rootElement);

// Рендерим приложение в StrictMode для выявления потенциальных проблем
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);