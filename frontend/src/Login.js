import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FaFingerprint, FaArrowUp } from 'react-icons/fa';
import { GiBubbles, GiWaterDrop } from 'react-icons/gi';
import icsLogo from './ICS-logo.png';
import './Login.css';

function Login({ onLoginSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleLogin = (e) => {
    e.preventDefault();
    if (username === 'icsAssure' && password === 'ics_forensic') {
      setLoginError(false);
      setIsLoggingIn(true);

      setTimeout(() => {
        if (onLoginSuccess) {
          onLoginSuccess();
        }
        setIsLoggingIn(false);
      }, 1000);
    } else {
      setLoginError(true);
    }
  };

  return (
    <div className="login-app-container">
      {/* Full Blue Background */}
      <div className="login-background">
        <div className="login-gradient-overlay"></div>
      </div>

      {/* Background Bubbles */}
      <div className="login-bubbles-container">
        {[...Array(20)].map((_, i) => (
          <div 
            key={i} 
            className="login-bubble" 
            style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              width: `${Math.random() * 40 + 20}px`,
              height: `${Math.random() * 40 + 20}px`,
              animationDelay: `${Math.random() * 5}s`,
              animationDuration: `${Math.random() * 20 + 10}s`
            }}
          />
        ))}
      </div>

      {/* Login Panel */}
      <AnimatePresence>
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          className="login-center-container"
        >
          <motion.div
            className="login-card"
            whileHover={{ scale: 1.02 }}
            transition={{ type: "spring", stiffness: 300 }}
          >
            {/* Login Animation during processing */}
            {isLoggingIn && (
              <div className="login-processing-overlay">
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                  className="login-spinner"
                />
                <p className="login-processing-text">Authenticating...</p>
              </div>
            )}

            <div className="login-header">
              <div className="login-logo-container">
                <img src={icsLogo} alt="ICS Logo" className="login-logo" />
                <div className="login-logo-text">
                  <h1 className="login-logo-title">ICS Assure</h1>
                  <p className="login-logo-subtitle">DOCUMENT PROCESSOR</p>
                </div>
              </div>
              <p className="login-subtitle">Secure Access Portal</p>
            </div>

            <form onSubmit={handleLogin} className="login-form">
              <div className="login-input-group">
                <label htmlFor="username" className="login-label">
                  User ID
                </label>
                <div className="login-input-wrapper">
                  <FaFingerprint className="login-input-icon" />
                  <input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Enter your user ID"
                    className={`login-input ${loginError ? 'login-input-error' : ''} ${isLoggingIn ? 'login-input-disabled' : ''}`}
                    disabled={isLoggingIn}
                    autoComplete="username"
                  />
                </div>
              </div>

              <div className="login-input-group">
                <label htmlFor="password" className="login-label">
                  Password
                </label>
                <div className="login-input-wrapper">
                  <GiBubbles className="login-input-icon" />
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className={`login-input ${loginError ? 'login-input-error' : ''} ${isLoggingIn ? 'login-input-disabled' : ''}`}
                    disabled={isLoggingIn}
                    autoComplete="current-password"
                  />
                </div>
              </div>

              {loginError && (
                <motion.p
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="login-error-message"
                >
                  Invalid credentials. Hint: ID: icsAssure | Pass: ics_forensic
                </motion.p>
              )}

              <motion.button
                type="submit"
                whileHover={{ scale: isLoggingIn ? 1 : 1.05 }}
                whileTap={{ scale: isLoggingIn ? 1 : 0.95 }}
                className={`login-submit-button ${isLoggingIn ? 'login-submit-button-disabled' : ''}`}
                disabled={isLoggingIn}
              >
                {isLoggingIn ? (
                  <>
                    <span>Logging In...</span>
                    <GiWaterDrop className="login-button-icon login-button-icon-animate" />
                  </>
                ) : (
                  <>
                    <span>Authenticate</span>
                    <FaArrowUp className="login-button-icon" />
                  </>
                )}
              </motion.button>

              <div className="login-hint">
                <div className="login-hint-bubble">
                  <GiBubbles className="login-hint-icon" />
                  <span>Hint: Look at the prompt</span>
                </div>
              </div>
            </form>

            <div className="login-water-effect">
              <div className="login-water-surface"></div>
            </div>
          </motion.div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

export default Login;