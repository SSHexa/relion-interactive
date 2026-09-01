import React from 'react';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import { ThemeContextProvider } from './contexts/ThemeContext';
import { SocketProvider } from './contexts/SocketContext';
import Dashboard from './pages/Dashboard';
import ErrorBoundary from './components/ErrorBoundary';

function App() {
  return (
    <ThemeContextProvider>
      <SocketProvider>
        <ErrorBoundary>
          <Router>
            <Routes>
              <Route path="/" element={<Dashboard />} />
            </Routes>
          </Router>
        </ErrorBoundary>
      </SocketProvider>
    </ThemeContextProvider>
  );
}

export default App;
