import React, { useState, useEffect } from 'react';
import Login from './Login';
import DocumentScanner from './Scanner';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Check for existing session on component mount
  useEffect(() => {
    const savedAuth = localStorage.getItem('isLoggedIn');
    if (savedAuth === 'true') {
      setIsAuthenticated(true);
    }
    setIsLoading(false);
  }, []);

  const handleLoginSuccess = () => {
    localStorage.setItem('isLoggedIn', 'true');
    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    localStorage.removeItem('isLoggedIn');
    setIsAuthenticated(false);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-900 via-blue-600 to-blue-400 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-16 w-16 border-t-4 border-b-4 border-white"></div>
          <p className="mt-4 text-white text-lg">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {isAuthenticated ? (
        <DocumentScanner onLogout={handleLogout} />
      ) : (
        <Login onLoginSuccess={handleLoginSuccess} />
      )}
    </div>
  );
}

export default App;