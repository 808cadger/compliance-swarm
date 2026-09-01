-- Backs a per-session, randomly generated demo step-up PIN (see auth/session.js's
-- generateDemoStepUpPin/verifyStepUpPin) replacing the old fixed, publicly-documented '1234'.
-- Only ever populated for demo_identity sessions; real password/passkey sessions never get one.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS step_up_pin_hash text;
