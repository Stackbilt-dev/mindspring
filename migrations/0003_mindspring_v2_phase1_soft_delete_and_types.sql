-- Extend notebook types and add soft-delete columns.

PRAGMA foreign_keys=OFF;

CREATE TABLE IF NOT EXISTS notebooks_new (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL CHECK(length(title) > 0),
    description TEXT,
    type TEXT NOT NULL CHECK(type IN ('conversation_archive','dev_docs', 'style_guide', 'narrative_bible', 'workflow_ops', 'personal_archive', 'research')),
    instructions TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

INSERT INTO notebooks_new (id, workspace_id, title, description, type, instructions, created_at, updated_at, deleted_at)
SELECT id, workspace_id, title, description, type, instructions, created_at, updated_at, NULL
FROM notebooks;

DROP TABLE notebooks;
ALTER TABLE notebooks_new RENAME TO notebooks;

CREATE INDEX IF NOT EXISTS idx_notebooks_workspace ON notebooks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_notebooks_workspace_active ON notebooks(workspace_id, deleted_at);

ALTER TABLE sources ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_sources_notebook_active ON sources(notebook_id, deleted_at);

PRAGMA foreign_keys=ON;
