/**
 * src/app/login.tsx — Login screen.
 *
 * Fields: org slug + email + password.
 * On success: token is stored in expo-secure-store via AuthContext.signIn();
 *             expo-router redirects to the schedule screen (index).
 *
 * SECURITY / UX:
 *   - Anti-enumeration: ALL auth failures show the SAME generic error message.
 *     We NEVER indicate whether the slug, email, or password was wrong —
 *     mirroring the server's byte-identical 401 response (ADR-0010).
 *   - Offline: NetworkError shows a distinct "check connection" message
 *     (not a credential error; no enumeration risk).
 *   - Input validation is client-side only (required fields). The server
 *     validates all input server-side; client validation prevents empty submits.
 *   - org_id is NEVER sent from the client; the server derives it from the slug.
 */

import React, { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../contexts/AuthContext';
import { AuthError, NetworkError } from '../lib/api';

export default function LoginScreen(): React.ReactElement {
  const router = useRouter();
  const { signIn } = useAuth();

  const [slug, setSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Field-level validation (client-side; required only).
  const [touched, setTouched] = useState({
    slug: false,
    email: false,
    password: false,
  });

  const slugError = touched.slug && !slug.trim() ? 'Organization slug is required' : null;
  const emailError = touched.email && !email.trim() ? 'Email is required' : null;
  const passwordError = touched.password && !password ? 'Password is required' : null;
  const hasFieldErrors = !!(slugError ?? emailError ?? passwordError);

  async function handleSubmit(): Promise<void> {
    // Mark all fields as touched to show inline errors.
    setTouched({ slug: true, email: true, password: true });

    if (!slug.trim() || !email.trim() || !password) {
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      await signIn({ slug: slug.trim(), email: email.trim().toLowerCase(), password });
      // signIn stores the token; expo-router will re-evaluate the root layout
      // and redirect to the authenticated index route.
      router.replace('/');
    } catch (err) {
      if (err instanceof NetworkError) {
        setErrorMessage('Could not connect. Please check your connection and try again.');
      } else if (err instanceof AuthError) {
        // Generic message — do NOT indicate which field was wrong (anti-enumeration).
        setErrorMessage('Invalid credentials. Please check your details and try again.');
      } else {
        // Unexpected error (server 5xx, etc.) — generic copy.
        setErrorMessage('Something went wrong. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.appName}>AeroOps</Text>
          <Text style={styles.tagline}>Flight Operations</Text>
        </View>

        {/* Form card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Sign In</Text>

          {/* Global error banner */}
          {errorMessage ? (
            <View style={styles.errorBanner} accessible accessibilityRole="alert">
              <Text style={styles.errorBannerText}>{errorMessage}</Text>
            </View>
          ) : null}

          {/* Org Slug */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Organization Slug</Text>
            <TextInput
              style={[styles.input, slugError ? styles.inputError : null]}
              value={slug}
              onChangeText={setSlug}
              onBlur={() => setTouched((t) => ({ ...t, slug: true }))}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="e.g. acme-flying-club"
              placeholderTextColor="#94a3b8"
              returnKeyType="next"
              accessibilityLabel="Organization slug"
              accessibilityHint="The URL identifier for your organization"
              editable={!isSubmitting}
            />
            {slugError ? (
              <Text style={styles.fieldError} accessibilityRole="alert">{slugError}</Text>
            ) : null}
          </View>

          {/* Email */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={[styles.input, emailError ? styles.inputError : null]}
              value={email}
              onChangeText={setEmail}
              onBlur={() => setTouched((t) => ({ ...t, email: true }))}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              placeholder="you@example.com"
              placeholderTextColor="#94a3b8"
              returnKeyType="next"
              accessibilityLabel="Email address"
              editable={!isSubmitting}
            />
            {emailError ? (
              <Text style={styles.fieldError} accessibilityRole="alert">{emailError}</Text>
            ) : null}
          </View>

          {/* Password */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Password</Text>
            <TextInput
              style={[styles.input, passwordError ? styles.inputError : null]}
              value={password}
              onChangeText={setPassword}
              onBlur={() => setTouched((t) => ({ ...t, password: true }))}
              secureTextEntry
              placeholder="••••••••"
              placeholderTextColor="#94a3b8"
              returnKeyType="done"
              onSubmitEditing={() => void handleSubmit()}
              accessibilityLabel="Password"
              editable={!isSubmitting}
            />
            {passwordError ? (
              <Text style={styles.fieldError} accessibilityRole="alert">{passwordError}</Text>
            ) : null}
          </View>

          {/* Submit */}
          <Pressable
            style={({ pressed }) => [
              styles.button,
              (isSubmitting || hasFieldErrors) && styles.buttonDisabled,
              pressed && !isSubmitting ? styles.buttonPressed : null,
            ]}
            onPress={() => void handleSubmit()}
            disabled={isSubmitting}
            accessibilityRole="button"
            accessibilityLabel="Sign in"
            accessibilityState={{ disabled: isSubmitting }}
          >
            {isSubmitting ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.buttonText}>Sign In</Text>
            )}
          </Pressable>
        </View>

        {/* Footer */}
        <Text style={styles.footer}>
          READ-ONLY schedule access. {'\n'}
          Contact your organization administrator to reset your password.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#f8fafc' },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
  },
  appName: {
    fontSize: 36,
    fontWeight: '800',
    color: '#1d4ed8',
    letterSpacing: -0.5,
  },
  tagline: {
    fontSize: 14,
    color: '#64748b',
    marginTop: 4,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  cardTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 20,
  },
  errorBanner: {
    backgroundColor: '#fef2f2',
    borderColor: '#fca5a5',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  errorBannerText: {
    color: '#dc2626',
    fontSize: 14,
    lineHeight: 20,
  },
  fieldGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#475569',
    marginBottom: 6,
    letterSpacing: 0.2,
  },
  input: {
    height: 48,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 16,
    color: '#0f172a',
    backgroundColor: '#f8fafc',
  },
  inputError: {
    borderColor: '#dc2626',
  },
  fieldError: {
    color: '#dc2626',
    fontSize: 12,
    marginTop: 4,
  },
  button: {
    height: 52,
    backgroundColor: '#1d4ed8',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  buttonDisabled: {
    backgroundColor: '#93c5fd',
  },
  buttonPressed: {
    backgroundColor: '#1e40af',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
  },
  footer: {
    textAlign: 'center',
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 24,
    lineHeight: 18,
  },
});
