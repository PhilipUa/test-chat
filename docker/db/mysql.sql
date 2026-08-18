-- Initial schema. Only executed on a *fresh* MySQL volume, so this is the greenfield shape;
-- src/db/migrate.ts applies the same structure idempotently at boot for installs that already
-- have a volume. Keep the two in agreement.

SET NAMES utf8mb4;

CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(190) NOT NULL,
  UNIQUE KEY uniq_users_email (email)
);

CREATE TABLE conversations (
  id INT PRIMARY KEY AUTO_INCREMENT,
  title VARCHAR(200) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE conversation_participants (
  conversation_id INT NOT NULL,
  user_id INT NOT NULL,
  -- Server-side unread watermark. The dot used to live only in a browser variable, so it
  -- couldn't survive a reload or agree between two tabs.
  last_read_message_id BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id),
  -- The PK is prefixed by conversation_id, so looking a user's conversations up by user_id
  -- (which the conversation list does) had no usable index.
  KEY idx_participants_user (user_id)
);

CREATE TABLE messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  conversation_id INT NOT NULL,
  sender_id INT NOT NULL,
  client_id VARCHAR(64) NULL,
  -- DATETIME(3): one timestamp is generated in the write path and stored in both MySQL and
  -- Mongo, which needs millisecond precision to round-trip identically.
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Every query in the app filters by conversation_id; covering (conversation_id, id) also turns
  -- `ORDER BY id` and `MAX(id)` into index seeks.
  KEY idx_messages_conversation (conversation_id, id),
  -- Makes a retried send idempotent. NULLs don't collide in a MySQL unique index, so messages
  -- sent without a client id are simply not deduplicated.
  UNIQUE KEY uniq_messages_client_id (conversation_id, client_id)
);

INSERT INTO users (id, name, email) VALUES
  (1, 'Alice', 'alice@example.com'),
  (2, 'Bob', 'bob@example.com'),
  (3, 'Carol', 'carol@example.com'),
  -- Dave and Erin exist so the presence tests have identities no other test connects as.
  -- Presence is shared, TTL-based state, so a test asserting "X is offline" is otherwise at the
  -- mercy of whatever else recently held a socket for X.
  (4, 'Dave', 'dave@example.com'),
  (5, 'Erin', 'erin@example.com');

INSERT INTO conversations (id, title) VALUES
  (1, 'Support — order #1042'),
  (2, 'Design sync');

INSERT INTO conversation_participants (conversation_id, user_id) VALUES
  (1, 1), (1, 2), (2, 1), (2, 3);

INSERT INTO messages (id, conversation_id, sender_id, client_id) VALUES
  (1, 1, 2, NULL),
  (2, 1, 1, NULL),
  (3, 2, 3, NULL);
