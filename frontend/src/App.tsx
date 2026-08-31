import React from 'react';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import { ThemeContextProvider } from './contexts/ThemeContext';
import Dashboard from './pages/Dashboard';
import ErrorBoundary from './components/ErrorBoundary';

function App() {
  return (
    <ThemeContextProvider>
      <ErrorBoundary>
        <Router>
          <Routes>
            <Route path="/" element={<Dashboard />} />
          </Routes>
        </Router>
      </ErrorBoundary>
    </ThemeContextProvider>
  );
}

export default App;
