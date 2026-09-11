import React, { createContext, useContext, useState, useEffect } from 'react';
import { User } from '../types/index.ts';
import { api, getStoredToken } from '../lib/api.ts';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  registerOrg: (name: string, email: string, password: string, orgName: string) => Promise<void>;
  logout: () => Promise<void>;
  updateProfile: (name: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const refreshUser = async () => {
    try {
      const data = await api.auth.getMe();
      setUser(data.user);
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    refreshUser();
  }, []);

  const login = async (email: string, password: string) => {
    const data = await api.auth.login(email, password);
    setUser(data.user);
  };

  const registerOrg = async (name: string, email: string, password: string, orgName: string) => {
    const data = await api.auth.registerOrg(name, email, password, orgName);
    setUser(data.user);
  };

  const logout = async () => {
    try {
      await api.auth.logout();
    } finally {
      setUser(null);
    }
  };

  const updateProfile = async (name: string) => {
    const data = await api.auth.updateProfile(name);
    setUser(data.user);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        login,
        registerOrg,
        logout,
        updateProfile,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
