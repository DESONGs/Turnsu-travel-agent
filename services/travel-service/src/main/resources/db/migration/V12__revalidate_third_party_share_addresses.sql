-- V11 lowercased complete addresses. The original local-part spelling cannot be
-- recovered, so require another verified Google login before it can be used to
-- find an account. Existing trip grants remain bound to stable account IDs.
UPDATE travel_accounts
SET verified_email=NULL, verified_email_hash=NULL, email_authoritative=false, email_verified_at=NULL
WHERE verified_email IS NOT NULL AND split_part(verified_email, '@', 2) <> 'gmail.com';
