# Supabase Database Schema

## Connection
- **URL**: `https://pfhgiyujvxeartkomrpv.supabase.co`
- **Extensions**: PostGIS 3.3.7, pgcrypto, uuid-ossp, pg_graphql, btree_gist

## Tables (29 total)

### Core Entities
| Table | PK | Key Columns | Notes |
|-------|-----|-------------|-------|
| `users` | userid (identity) | role (userrole enum) | Central user table |
| `userinfo` | infoid | userid FK, name, contactnumber (unique), email (unique), pfp, biography | Profile data |
| `userlogin` | loginid | userid FK, username (unique), passwordhash, logintype | Only table with RLS enabled |
| `user_auth_providers` | authproviderid | userid FK, provider (Local/Google/Zalo/Phone), provider_uid | Multi-provider auth |
| `user_devices` | deviceid | userid FK, push_token (unique), platform, token_type | Push notification targets |
| `user_tokens` | tokenid | userid FK, refresh_token, device_fingerprint, expires_at | Session management |
| `unverified_users` | id | userid FK, email, verification_type | Email/phone verification pending |

### Courts & Venues
| Table | PK | Key Columns | Notes |
|-------|-----|-------------|-------|
| `courts` | courtid | userid FK (owner), location (geography), address, status (court_status enum), area_type | Venue entity |
| `courtinfo` | courtinfoid | courtid FK (CASCADE), name, description, type, cover_image | Venue display info |
| `playingcourt` | playingcourtid | courtid FK (CASCADE), base_name, name, part (full/half_a/half_b), surface, price, allow_half_booking | Bookable court unit |
| `playingcourtinfo` | playingcourtinfoid | playingcourtid FK, description, images (text[]) | Court images/details |
| `courtavailability` | availabilityid | playingcourtid FK, date, start_time, end_time, status | Time slots |
| `court_schedule_rules` | ruleid | courtid FK, day_of_week, start_time, end_time, is_active | Recurring schedule template |
| `favouritecourts` | favouritecourtid | userid FK (CASCADE), courtid FK (CASCADE) | User favourites |

### Bookings
| Table | PK | Key Columns | Notes |
|-------|-----|-------------|-------|
| `courtbooking` | courtbookingid | userid FK, playingcourtid FK, selected_court_name, date, start_time, end_time, duration_minutes (60-180), total_amount, status | Court booking |
| `eventbooking` | eventbookingid | userid FK, eventid FK, status | Event registration |
| `tsbookings` | tsbookingid | userid FK, sessionid FK, status | Training session registration |
| `servicebooking` | servicebookingid | courtbookingid FK, serviceid FK, quantity | Add-on services |

### Events & Training
| Table | PK | Key Columns | Notes |
|-------|-----|-------------|-------|
| `events` | eventid | courtbookingid FK (unique), created_by FK, status | Event linked to court booking |
| `eventinfo` | eventinfoid | eventid FK, title, description, entry_fee, participants_cap, images, cover_image | Event display info |
| `trainingsessions` | sessionid | courtbookingid FK, created_by FK, status | Training session linked to booking |
| `trainingsessioninfo` | tsinfoid | sessionid FK, title, description, entry_fee, participants_cap, images, cover_image | TS display info |

### Other
| Table | PK | Key Columns | Notes |
|-------|-----|-------------|-------|
| `services` | serviceid | courtid FK, name, category (consumable/rental), price, status | Court add-on services |
| `payments` | paymentid | courtbookingid FK, amount, method (vnpay/cash), status | Payment records |
| `notifications` | notificationid | userid FK, sender_userid FK, title, category, kind, data (jsonb), read_at | Push + in-app |
| `reviews` | reviewid | userid FK, targettype, targetid, comment, starrating, like_count, dislike_count | Court reviews |
| `review_reactions` | reactionid | reviewid FK (CASCADE), userid FK (CASCADE), reaction_type (like/dislike) | Review votes |
| `block_list` | blockid | targettype, targetid, blocked_userid FK | Event/TS blocks |

## Key Enums
- `userrole`: player, coach, organizer, courtowner
- `court_status`: pending, verified, rejected, suspended
- `courtbookingstatus`: pending, approved, rejected, missed
- `courtsurface`: hardwood, concrete, synthetic, grass, clay
- `paymentmethod`: vnpay, cash
- `venue_type`: Indoor, Outdoor, Both
- `court_area_type`: Various area classifications
- `notification_category`: court, event, training

## Key Foreign Key Cascades
- `courts → users` (SET NULL on delete)
- `courtinfo → courts` (CASCADE delete)
- `playingcourt → courts` (CASCADE delete)
- `favouritecourts → users/courts` (CASCADE delete)
- `userinfo/userlogin/user_tokens/user_devices → users` (CASCADE delete)
- `review_reactions → reviews/users` (CASCADE delete)

## Triggers
- `trg_set_courtbooking_duration`: Auto-calculates duration_minutes on INSERT/UPDATE
- `trg_review_reaction_counts`: Syncs like_count/dislike_count on review_reactions changes
- `trg_reviews_eligibility`: Enforces completed court trip before allowing review
- `trg_review_reactions_eligibility`: Same for reactions

## RLS Status
All tables have RLS **disabled** except `userlogin` (single permissive "Enable access for all users" policy). Security enforced at API/backend level.
