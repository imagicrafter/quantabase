"""Rewriting the schema name in SQL at apply time. Pure text in, text out.

Migration files are written with the schema called `workspace`. A deployment
that chose another name (KB_SCHEMA) gets the same SQL with every reference to
that schema renamed. Nothing else changes.

The SQL is split into code, comments, string literals, quoted identifiers
and dollar-quoted bodies. Comments are left exactly as written. Everywhere
else, each place the name appears must be one of the forms below, or the
rewrite REFUSES (SchemaRewriteError) -- an object in the wrong schema, or a
function with the wrong search_path, is a security bug, so nothing is guessed.

    workspace.thing  "workspace".thing        a schema-qualified name
    create|drop|alter|on|in|set schema workspace
    search_path = workspace, ...  (or `to`)   a pinned search path
    'workspace'::regnamespace                 a string used as a schema name
    table_schema = 'workspace'                (also schemaname, nspname, ...)
    format('%I.%I', 'workspace', ...)         (only when every slot is %I)
    to_regnamespace('workspace')  has_schema_privilege(role, 'workspace', 'usage')
    'workspace.t'::regclass  to_regclass('workspace.t')
    has_table_privilege(role, 'workspace.t', 'select')   (any has_*_privilege)

Longer strings (dynamic SQL, messages) and function bodies are searched for
the same forms. Refused outright, because they cannot be told apart from a
schema name or cannot be read reliably: the bare word as a column, alias or
value; a string that is only `workspace.name` with nothing around it saying
it names an object; a custom setting (`set workspace.x`, `current_setting(
'workspace.x')`); another spelling in a string (`'Workspace'`); `U&` quoting;
a string continued on the next line. With the target equal to the written
name the input is returned untouched.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from knowledge.kb_schema import DEFAULT_SCHEMA, validate

from .errors import KbeError

CODE, COMMENT, STRING, IDENT, DOLLAR = "code", "comment", "string", "ident", "dollar"
_CONTEXT_CHARS = 400
# Postgres lets any character above ASCII into a name or a dollar-quote tag.
_HIGH = "\u0080-\U0010ffff"
_WORD = rf"[A-Za-z0-9_${_HIGH}]"
_OPENERS = re.compile(rf"--|/\*|[eE]?'|\"|\$(?:[A-Za-z_{_HIGH}][A-Za-z0-9_{_HIGH}]*)?\$")
_PLAIN_STRING = re.compile(r"'(?:[^']|'')*'")
_ESCAPE_STRING = re.compile(r"'(?:[^'\\]|\\.|'')*'", re.S)
_QUOTED_IDENT = re.compile(r'"(?:[^"]|"")*"')
_BODY_INTRO = re.compile(r"\b(?:as|do)\s*$", re.I)
_UNICODE_QUOTE = re.compile(r"(?<![A-Za-z0-9_$])u&$", re.I)
_CONTINUES = re.compile(r"\s*\n\s*")
_SCHEMA_KEYWORD = re.compile(
    r"\b(?:create|drop|alter|on|in|set)\s+schema\s+(?:if\s+(?:not\s+)?exists\s+)?$", re.I
)
_SEARCH_PATH = re.compile(
    r"\bsearch_path\s*(?:=|\bto\b)\s*(?:\"?[A-Za-z_][A-Za-z0-9_$]*\"?\s*,\s*)*$", re.I
)
_SETTING = re.compile(r"\b(?:set|reset|show)\s+(?:local\s+|session\s+)?$", re.I)
_SETTING_CALL = re.compile(r"\b(?:current_setting|set_config)\s*\(\s*$", re.I)
_QUALIFIER = re.compile(r"\.[A-Za-z_\"*%]")
_REGNAMESPACE = re.compile(r"\s*::\s*regnamespace\b", re.I)
_SCHEMA_COLUMN = re.compile(
    r"(?<![A-Za-z0-9_$])(?:[A-Za-z_][A-Za-z0-9_]*\.)?"
    r"(?:table_schema|routine_schema|specific_schema|constraint_schema|sequence_schema"
    r"|trigger_schema|event_object_schema|udt_schema|view_schema|schemaname|schema_name"
    r"|nspname)\s*(?:=|<>|!=|\bin\s*\()\s*$",
    re.I,
)
_INSIDE_CALL = r"\s*\((?:[^()]|\([^()]*\))*$"
_TO_REGNAMESPACE = re.compile(r"\bto_regnamespace\s*\(\s*$", re.I)
_SCHEMA_PRIVILEGE = re.compile(r"\bhas_schema_privilege" + _INSIDE_CALL, re.I)
_LAST_BUT_ONE = re.compile(r"\s*,\s*'[^']*'\s*\)")
_FORMAT_CALL = re.compile(r"\bformat\s*\(\s*'((?:[^']|'')*)'\s*,(?:[^()]|\([^()]*\))*$", re.I)
_FORMAT_SLOT = re.compile(r"%(?:\d+\$)?-?\d*(.)", re.S)
_OBJECT_CALL = re.compile(
    r"\b(?:to_reg[a-z]+|has_[a-z_]+_privilege|pg_get_serial_sequence)" + _INSIDE_CALL, re.I
)
_OBJECT_CAST = re.compile(r"\s*::\s*reg[a-z]+\b", re.I)


class SchemaRewriteError(KbeError):
    """The SQL names the schema in a way this tool will not rewrite."""


@dataclass(frozen=True)
class Segment:
    kind: str
    opener: str
    body: str
    closer: str

    @property
    def text(self) -> str:
        return f"{self.opener}{self.body}{self.closer}"


@dataclass(frozen=True)
class _Names:
    source: str
    target: str
    pattern: re.Pattern
    # A string that is nothing but `<source>.name` or `<source>.name(args)`.
    dotted: re.Pattern


def _block_comment_end(sql: str, start: int) -> int:
    depth, index = 0, start
    while index < len(sql):
        if sql.startswith("/*", index):
            depth, index = depth + 1, index + 2
        elif sql.startswith("*/", index):
            depth, index = depth - 1, index + 2
            if depth == 0:
                return index
        else:
            index += 1
    raise SchemaRewriteError("A /* comment is never closed.")


def _quoted(sql: str, start: int, pattern: re.Pattern, kind: str, opener: str) -> Segment:
    found = pattern.match(sql, start + len(opener) - 1)
    if found is None:
        raise SchemaRewriteError(f"A quote opened on line {_line(sql, start)} is never closed.")
    return Segment(kind, opener, found.group()[1:-1], found.group()[-1])


def _dollar(sql: str, start: int, tag: str) -> Segment:
    end = sql.find(tag, start + len(tag))
    if end < 0:
        raise SchemaRewriteError(f"{tag} opened on line {_line(sql, start)} is never closed.")
    return Segment(DOLLAR, tag, sql[start + len(tag):end], tag)


def _special(sql: str, start: int, opener: str) -> Segment | None:
    """The comment, literal or quoted name that starts at `start`, if one does."""
    glued = start > 0 and re.fullmatch(_WORD, sql[start - 1]) is not None
    if opener == "--":
        end = sql.find("\n", start)
        return Segment(COMMENT, "", sql[start:len(sql) if end < 0 else end], "")
    if opener == "/*":
        return Segment(COMMENT, "", sql[start:_block_comment_end(sql, start)], "")
    if opener == '"':
        return _quoted(sql, start, _QUOTED_IDENT, IDENT, '"')
    if opener == "'":
        return _quoted(sql, start, _PLAIN_STRING, STRING, "'")
    if opener.startswith("$"):
        return None if glued else _dollar(sql, start, opener)
    # e'...' -- unless the e is the tail of a longer word.
    return None if glued else _quoted(sql, start, _ESCAPE_STRING, STRING, opener)


def scan(sql: str) -> tuple[Segment, ...]:
    """Split SQL into segments. Joining their text gives the input back."""
    segments: list[Segment] = []
    code_from = index = 0
    while True:
        found = _OPENERS.search(sql, index)
        if found is None:
            break
        special = _special(sql, found.start(), found.group())
        if special is None:
            index = found.start() + 1
            continue
        if found.start() > code_from:
            segments.append(Segment(CODE, "", sql[code_from:found.start()], ""))
        segments.append(special)
        code_from = index = found.start() + len(special.text)
    if code_from < len(sql):
        segments.append(Segment(CODE, "", sql[code_from:], ""))
    return tuple(segments)


def _line(sql: str, offset: int) -> int:
    return sql.count("\n", 0, offset) + 1


def _refuse(names: _Names, where: str, snippet: str) -> SchemaRewriteError:
    shown = " ".join(snippet.split())
    return SchemaRewriteError(
        f'Cannot safely rename schema "{names.source}" to "{names.target}": the SQL '
        f"uses the name in a way this tool does not recognise ({where}): ...{shown}... "
        "Write it as a schema-qualified name, or keep the default schema."
    )


def _bare_names_schema(lead: str, tail: str) -> bool:
    """Is a bare (or double-quoted) name here a schema name?"""
    if lead.endswith(".") or _SETTING.search(lead):
        return False
    if _SCHEMA_KEYWORD.search(lead) or _SEARCH_PATH.search(lead):
        return True
    return _QUALIFIER.match(tail) is not None


def _only_identifier_slots(template: str) -> bool:
    slots = [kind for kind in _FORMAT_SLOT.findall(template) if kind != "%"]
    return bool(slots) and all(kind == "I" for kind in slots)


def _literal_names_schema(lead: str, tail: str) -> bool:
    """Is a string that holds exactly the name being used as a schema name?"""
    if _REGNAMESPACE.match(tail) or _SCHEMA_COLUMN.search(lead) or _TO_REGNAMESPACE.search(lead):
        return True
    if _SCHEMA_PRIVILEGE.search(lead) and _LAST_BUT_ONE.match(tail):
        return True
    call = _FORMAT_CALL.search(lead)
    return call is not None and _only_identifier_slots(call.group(1))


def _names_object(lead: str, tail: str) -> bool:
    """Is a string that holds exactly `schema.name` naming a database object?"""
    return bool(_OBJECT_CAST.match(tail) or _OBJECT_CALL.search(lead))


def _known(found: re.Match, lead: str, tail: str, names: _Names, where: str) -> bool:
    if where == CODE:
        return _bare_names_schema(lead, tail)
    if found.group() != names.source:
        return False  # 'Workspace' in a string is some other value
    if lead.endswith("''") and tail.startswith("''"):
        return _literal_names_schema(lead[:-2], tail[2:])
    return _bare_names_schema(lead, tail)


def _rewrite_text(text: str, before: str, after: str, names: _Names, where: str) -> str:
    """Rename every occurrence in code or inside a string, or refuse."""
    out: list[str] = []
    last = 0
    for found in names.pattern.finditer(text):
        lead = (before + text[:found.start()])[-_CONTEXT_CHARS:]
        tail = (text[found.end():] + after)[:_CONTEXT_CHARS]
        if not _known(found, lead, tail, names, where):
            raise _refuse(names, where, text[max(0, found.start() - 40):found.end() + 40])
        out.extend((text[last:found.start()], names.target))
        last = found.end()
    out.append(text[last:])
    return "".join(out)


def _rewrite_literal(segment: Segment, before: str, after: str, names: _Names) -> str:
    """The contents of a string literal (or a dollar-quoted string)."""
    body = segment.body
    shown = f"{before[-40:]}{segment.text}{after[:40]}"
    if names.pattern.fullmatch(body):
        if body != names.source or not _literal_names_schema(before, after):
            raise _refuse(names, STRING, shown)
        return names.target
    if names.pattern.match(body) and _SETTING_CALL.search(before):
        raise _refuse(names, "a setting name", shown)
    if names.dotted.fullmatch(body) and not _names_object(before, after):
        raise _refuse(names, "a string that may not name an object", shown)
    return _rewrite_text(body, "", "", names, STRING)


def _rewrite_ident(segment: Segment, before: str, after: str, names: _Names) -> str:
    if segment.body != names.source:
        return segment.body
    if not _bare_names_schema(before, after):
        raise _refuse(names, "quoted name", f"{before[-40:]}{segment.text}{after[:40]}")
    return names.target


def _rewrite_segment(segment: Segment, before: str, after: str, names: _Names) -> str:
    if segment.kind == COMMENT:
        return segment.text
    if segment.kind == CODE:
        body = _rewrite_text(segment.body, before, after, names, CODE)
    elif segment.kind == IDENT:
        body = _rewrite_ident(segment, before, after, names)
    elif segment.kind == DOLLAR and _BODY_INTRO.search(before):
        body = _rewrite(segment.body, names)
    else:
        body = _rewrite_literal(segment, before, after, names)
    return f"{segment.opener}{body}{segment.closer}"


def _refuse_unreadable(segments: tuple[Segment, ...], index: int, before: str,
                       names: _Names) -> None:
    """Spellings of a name or string that this tool does not decode."""
    segment = segments[index]
    if segment.kind not in (STRING, IDENT):
        return
    if _UNICODE_QUOTE.search(before):
        raise _refuse(names, "U& quoting", f"{before[-10:]}{segment.text}")
    follows = segments[index + 1:index + 3]
    continued = (
        segment.kind == STRING and len(follows) == 2 and follows[1].kind == STRING
        and follows[0].kind == CODE and _CONTINUES.fullmatch(follows[0].body) is not None
    )
    if not continued:
        return
    joined = segment.body + follows[1].body
    parts_hold_it = any(names.pattern.search(part) for part in (segment.body, follows[1].body))
    if names.pattern.search(joined) and not parts_hold_it:
        raise _refuse(names, "a string continued on the next line", joined)


def _rewrite(sql: str, names: _Names) -> str:
    segments = scan(sql)
    out: list[str] = []
    before = ""
    for index, segment in enumerate(segments):
        after = "".join(s.text for s in segments[index + 1:index + 4])[:_CONTEXT_CHARS]
        _refuse_unreadable(segments, index, before, names)
        out.append(_rewrite_segment(segment, before, after, names))
        if segment.kind != COMMENT:
            before = (before + segment.text)[-_CONTEXT_CHARS:]
    return "".join(out)


def rewrite_schema(sql: str, target: str, source: str = DEFAULT_SCHEMA) -> str:
    """`sql` with the schema `source` renamed to `target`.

    Returns the input untouched when the two are the same. Raises
    SchemaRewriteError when the name is used in a form that is not recognised.
    """
    try:
        names = _Names(
            validate(source), validate(target),
            re.compile(rf"(?<!{_WORD}){re.escape(source)}(?!{_WORD})", re.I),
            re.compile(rf"{re.escape(source)}\.[A-Za-z_][A-Za-z0-9_$]*(?:\s*\(.*\))?", re.S),
        )
    except ValueError as error:
        raise SchemaRewriteError(str(error)) from error
    if names.source == names.target:
        return sql
    return _rewrite(sql, names)
