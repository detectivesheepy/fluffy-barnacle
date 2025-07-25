ace.define("ace/ext/hardwrap",["require","exports","module","ace/range","ace/editor","ace/config"], function(require, exports, module){/**
 * ## Text hard wrapping extension for automatic line breaking and text formatting.
 *
 * Provides intelligent line wrapping functionality that breaks long lines at configurable column limits while
 * preserving indentation and optionally merging short adjacent lines. Supports both automatic wrapping during text
 * input and manual formatting of selected text ranges.
 *
 * **Enable:** `editor.setOption("hardWrap", true)`
 * or configure it during editor initialization in the options object.
 * @module
 */
"use strict";
var Range = require("../range").Range;
function hardWrap(editor, options) {
    var max = options.column || editor.getOption("printMarginColumn");
    var allowMerge = options.allowMerge != false;
    var row = Math.min(options.startRow, options.endRow);
    var endRow = Math.max(options.startRow, options.endRow);
    var session = editor.session;
    while (row <= endRow) {
        var line = session.getLine(row);
        if (line.length > max) {
            var space = findSpace(line, max, 5);
            if (space) {
                var indentation = /^\s*/.exec(line)[0];
                session.replace(new Range(row, space.start, row, space.end), "\n" + indentation);
            }
            endRow++;
        }
        else if (allowMerge && /\S/.test(line) && row != endRow) {
            var nextLine = session.getLine(row + 1);
            if (nextLine && /\S/.test(nextLine)) {
                var trimmedLine = line.replace(/\s+$/, "");
                var trimmedNextLine = nextLine.replace(/^\s+/, "");
                var mergedLine = trimmedLine + " " + trimmedNextLine;
                var space = findSpace(mergedLine, max, 5);
                if (space && space.start > trimmedLine.length || mergedLine.length < max) {
                    var replaceRange = new Range(row, trimmedLine.length, row + 1, nextLine.length - trimmedNextLine.length);
                    session.replace(replaceRange, " ");
                    row--;
                    endRow--;
                }
                else if (trimmedLine.length < line.length) {
                    session.remove(new Range(row, trimmedLine.length, row, line.length));
                }
            }
        }
        row++;
    }
    function findSpace(line, max, min) {
        if (line.length < max)
            return;
        var before = line.slice(0, max);
        var after = line.slice(max);
        var spaceAfter = /^(?:(\s+)|(\S+)(\s+))/.exec(after);
        var spaceBefore = /(?:(\s+)|(\s+)(\S+))$/.exec(before);
        var start = 0;
        var end = 0;
        if (spaceBefore && !spaceBefore[2]) {
            start = max - spaceBefore[1].length;
            end = max;
        }
        if (spaceAfter && !spaceAfter[2]) {
            if (!start)
                start = max;
            end = max + spaceAfter[1].length;
        }
        if (start) {
            return {
                start: start,
                end: end
            };
        }
        if (spaceBefore && spaceBefore[2] && spaceBefore.index > min) {
            return {
                start: spaceBefore.index,
                end: spaceBefore.index + spaceBefore[2].length
            };
        }
        if (spaceAfter && spaceAfter[2]) {
            start = max + spaceAfter[2].length;
            return {
                start: start,
                end: start + spaceAfter[3].length
            };
        }
    }
}
function wrapAfterInput(e) {
    if (e.command.name == "insertstring" && /\S/.test(e.args)) {
        var editor = e.editor;
        var cursor = editor.selection.cursor;
        if (cursor.column <= editor.renderer.$printMarginColumn)
            return;
        var lastDelta = editor.session.$undoManager.$lastDelta;
        hardWrap(editor, {
            startRow: cursor.row, endRow: cursor.row,
            allowMerge: false
        });
        if (lastDelta != editor.session.$undoManager.$lastDelta)
            editor.session.markUndoGroup();
    }
}
var Editor = require("../editor").Editor;
require("../config").defineOptions(Editor.prototype, "editor", {
    hardWrap: {
        set: function (val) {
            if (val) {
                this.commands.on("afterExec", wrapAfterInput);
            }
            else {
                this.commands.off("afterExec", wrapAfterInput);
            }
        },
        value: false
    }
});
exports.hardWrap = hardWrap;

});

ace.define("ace/keyboard/vim",["require","exports","module","ace/range","ace/lib/event_emitter","ace/lib/dom","ace/lib/oop","ace/lib/keys","ace/lib/event","ace/search","ace/lib/useragent","ace/search_highlight","ace/commands/multi_select_commands","ace/mode/text","ace/ext/hardwrap","ace/multi_select"], function(require, exports, module){// CodeMirror, copyright (c) by Marijn Haverbeke and others
'use strict';
function log() {
    var d = "";
    function format(p) {
        if (typeof p != "object")
            return p + "";
        if ("line" in p) {
            return p.line + ":" + p.ch;
        }
        if ("anchor" in p) {
            return format(p.anchor) + "->" + format(p.head);
        }
        if (Array.isArray(p))
            return "[" + p.map(function (x) {
                return format(x);
            }) + "]";
        return JSON.stringify(p);
    }
    for (var i = 0; i < arguments.length; i++) {
        var p = arguments[i];
        var f = format(p);
        d += f + "  ";
    }
    console.log(d);
}
var Range = require("../range").Range;
var EventEmitter = require("../lib/event_emitter").EventEmitter;
var domLib = require("../lib/dom");
var oop = require("../lib/oop");
var KEYS = require("../lib/keys");
var event = require("../lib/event");
var Search = require("../search").Search;
var useragent = require("../lib/useragent");
var SearchHighlight = require("../search_highlight").SearchHighlight;
var multiSelectCommands = require("../commands/multi_select_commands");
var TextModeTokenRe = require("../mode/text").Mode.prototype.tokenRe;
var hardWrap = require("../ext/hardwrap").hardWrap;
require("../multi_select");
var CodeMirror = function (ace) {
    this.ace = ace;
    this.state = {};
    this.marks = {};
    this.options = {};
    this.$uid = 0;
    this.onChange = this.onChange.bind(this);
    this.onSelectionChange = this.onSelectionChange.bind(this);
    this.onBeforeEndOperation = this.onBeforeEndOperation.bind(this);
    this.ace.on('change', this.onChange);
    this.ace.on('changeSelection', this.onSelectionChange);
    this.ace.on('beforeEndOperation', this.onBeforeEndOperation);
};
CodeMirror.Pos = function (line, ch) {
    if (!(this instanceof Pos))
        return new Pos(line, ch);
    this.line = line;
    this.ch = ch;
};
CodeMirror.defineOption = function (name, val, setter) { };
CodeMirror.commands = {
    redo: function (cm) { cm.ace.redo(); },
    undo: function (cm) { cm.ace.undo(); },
    newlineAndIndent: function (cm) { cm.ace.insert("\n"); },
    goLineLeft: function (cm) { cm.ace.selection.moveCursorLineStart(); },
    goLineRight: function (cm) { cm.ace.selection.moveCursorLineEnd(); }
};
CodeMirror.keyMap = {};
CodeMirror.addClass = CodeMirror.rmClass = function () { };
CodeMirror.e_stop = CodeMirror.e_preventDefault = event.stopEvent;
CodeMirror.keyName = function (e) {
    var key = (KEYS[e.keyCode] || e.key || "");
    if (key.length == 1)
        key = key.toUpperCase();
    key = event.getModifierString(e).replace(/(^|-)\w/g, function (m) {
        return m.toUpperCase();
    }) + key;
    return key;
};
CodeMirror.keyMap['default'] = function (key) {
    return function (cm) {
        var cmd = cm.ace.commands.commandKeyBinding[key.toLowerCase()];
        return cmd && cm.ace.execCommand(cmd) !== false;
    };
};
CodeMirror.lookupKey = function lookupKey(key, map, handle) {
    if (!map)
        map = "default";
    if (typeof map == "string")
        map = CodeMirror.keyMap[map] || CodeMirror.keyMap['default'];
    var found = typeof map == "function" ? map(key) : map[key];
    if (found === false)
        return "nothing";
    if (found === "...")
        return "multi";
    if (found != null && handle(found))
        return "handled";
    if (map.fallthrough) {
        if (!Array.isArray(map.fallthrough))
            return lookupKey(key, map.fallthrough, handle);
        for (var i = 0; i < map.fallthrough.length; i++) {
            var result = lookupKey(key, map.fallthrough[i], handle);
            if (result)
                return result;
        }
    }
};
CodeMirror.findMatchingTag = function (cm, head) {
    return cm.findMatchingTag(head);
};
CodeMirror.findEnclosingTag = function (cm, head) {
};
CodeMirror.signal = function (o, name, e) { return o._signal(name, e); };
CodeMirror.on = event.addListener;
CodeMirror.off = event.removeListener;
CodeMirror.isWordChar = function (ch) {
    if (ch < "\x7f")
        return /^\w$/.test(ch);
    TextModeTokenRe.lastIndex = 0;
    return TextModeTokenRe.test(ch);
};
(function () {
    oop.implement(CodeMirror.prototype, EventEmitter);
    this.destroy = function () {
        this.ace.off('change', this.onChange);
        this.ace.off('changeSelection', this.onSelectionChange);
        this.ace.off('beforeEndOperation', this.onBeforeEndOperation);
        this.removeOverlay();
    };
    this.virtualSelectionMode = function () {
        return this.ace.inVirtualSelectionMode && this.ace.selection.index;
    };
    this.onChange = function (delta) {
        if (this.$lineHandleChanges) {
            this.$lineHandleChanges.push(delta);
        }
        var change = { text: delta.action[0] == 'i' ? delta.lines : [] };
        var curOp = this.curOp = this.curOp || {};
        if (!curOp.changeHandlers)
            curOp.changeHandlers = this._eventRegistry["change"] && this._eventRegistry["change"].slice();
        if (!curOp.lastChange) {
            curOp.lastChange = curOp.change = change;
        }
        else {
            curOp.lastChange.next = curOp.lastChange = change;
        }
        this.$updateMarkers(delta);
    };
    this.onSelectionChange = function () {
        var curOp = this.curOp = this.curOp || {};
        if (!curOp.cursorActivityHandlers)
            curOp.cursorActivityHandlers = this._eventRegistry["cursorActivity"] && this._eventRegistry["cursorActivity"].slice();
        this.curOp.cursorActivity = true;
        if (this.ace.inMultiSelectMode) {
            this.ace.keyBinding.removeKeyboardHandler(multiSelectCommands.keyboardHandler);
        }
    };
    this.operation = function (fn, force) {
        if (!force && this.curOp || force && this.curOp && this.curOp.force) {
            return fn();
        }
        if (force || !this.ace.curOp) {
            if (this.curOp)
                this.onBeforeEndOperation();
        }
        if (!this.ace.curOp) {
            var prevOp = this.ace.prevOp;
            this.ace.startOperation({
                command: { name: "vim", scrollIntoView: "cursor" }
            });
        }
        var curOp = this.curOp = this.curOp || {};
        this.curOp.force = force;
        var result = fn();
        if (this.ace.curOp && this.ace.curOp.command.name == "vim") {
            if (this.state.dialog)
                this.ace.curOp.command.scrollIntoView = this.ace.curOp.vimDialogScroll;
            this.ace.endOperation();
            if (!curOp.cursorActivity && !curOp.lastChange && prevOp)
                this.ace.prevOp = prevOp;
        }
        if (force || !this.ace.curOp) {
            if (this.curOp)
                this.onBeforeEndOperation();
        }
        return result;
    };
    this.onBeforeEndOperation = function () {
        var op = this.curOp;
        if (op) {
            if (op.change) {
                this.signal("change", op.change, op);
            }
            if (op && op.cursorActivity) {
                this.signal("cursorActivity", null, op);
            }
            this.curOp = null;
        }
    };
    this.signal = function (eventName, e, handlers) {
        var listeners = handlers ? handlers[eventName + "Handlers"]
            : (this._eventRegistry || {})[eventName];
        if (!listeners)
            return;
        listeners = listeners.slice();
        for (var i = 0; i < listeners.length; i++)
            listeners[i](this, e);
    };
    this.firstLine = function () { return 0; };
    this.lastLine = function () { return this.ace.session.getLength() - 1; };
    this.lineCount = function () { return this.ace.session.getLength(); };
    this.setCursor = function (line, ch) {
        if (typeof line === 'object') {
            ch = line.ch;
            line = line.line;
        }
        var shouldScroll = !this.curOp && !this.ace.inVirtualSelectionMode;
        if (!this.ace.inVirtualSelectionMode)
            this.ace.exitMultiSelectMode();
        this.ace.session.unfold({ row: line, column: ch });
        this.ace.selection.moveTo(line, ch);
        if (shouldScroll) {
            this.ace.renderer.scrollCursorIntoView();
            this.ace.endOperation();
        }
    };
    this.getCursor = function (p) {
        var sel = this.ace.selection;
        var pos = p == 'anchor' ? (sel.isEmpty() ? sel.lead : sel.anchor) :
            p == 'head' || !p ? sel.lead : sel.getRange()[p];
        return toCmPos(pos);
    };
    this.listSelections = function (p) {
        var ranges = this.ace.multiSelect.rangeList.ranges;
        if (!ranges.length || this.ace.inVirtualSelectionMode)
            return [{ anchor: this.getCursor('anchor'), head: this.getCursor('head') }];
        return ranges.map(function (r) {
            return {
                anchor: this.clipPos(toCmPos(r.cursor == r.end ? r.start : r.end)),
                head: this.clipPos(toCmPos(r.cursor))
            };
        }, this);
    };
    this.setSelections = function (p, primIndex) {
        var sel = this.ace.multiSelect;
        var ranges = p.map(function (x) {
            var anchor = toAcePos(x.anchor);
            var head = toAcePos(x.head);
            var r = Range.comparePoints(anchor, head) < 0
                ? new Range.fromPoints(anchor, head)
                : new Range.fromPoints(head, anchor);
            r.cursor = Range.comparePoints(r.start, head) ? r.end : r.start;
            return r;
        });
        if (this.ace.inVirtualSelectionMode) {
            this.ace.selection.fromOrientedRange(ranges[0]);
            return;
        }
        if (!primIndex) {
            ranges = ranges.reverse();
        }
        else if (ranges[primIndex]) {
            ranges.push(ranges.splice(primIndex, 1)[0]);
        }
        sel.toSingleRange(ranges[0].clone());
        var session = this.ace.session;
        for (var i = 0; i < ranges.length; i++) {
            var range = session.$clipRangeToDocument(ranges[i]); // todo why ace doesn't do this?
            sel.addRange(range);
        }
    };
    this.setSelection = function (a, h, options) {
        var sel = this.ace.selection;
        sel.moveTo(a.line, a.ch);
        sel.selectTo(h.line, h.ch);
        if (options && options.origin == '*mouse') {
            this.onBeforeEndOperation();
        }
    };
    this.somethingSelected = function (p) {
        return !this.ace.selection.isEmpty();
    };
    this.clipPos = function (p) {
        var pos = this.ace.session.$clipPositionToDocument(p.line, p.ch);
        return toCmPos(pos);
    };
    this.foldCode = function (pos) {
        this.ace.session.$toggleFoldWidget(pos.line, {});
    };
    this.markText = function (cursor) {
        return { clear: function () { }, find: function () { } };
    };
    this.$updateMarkers = function (delta) {
        var isInsert = delta.action == "insert";
        var start = delta.start;
        var end = delta.end;
        var rowShift = (end.row - start.row) * (isInsert ? 1 : -1);
        var colShift = (end.column - start.column) * (isInsert ? 1 : -1);
        if (isInsert)
            end = start;
        for (var i in this.marks) {
            var point = this.marks[i];
            var cmp = Range.comparePoints(point, start);
            if (cmp < 0) {
                continue; // delta starts after the range
            }
            if (cmp === 0) {
                if (isInsert) {
                    if (!point.$insertRight) {
                        cmp = 1;
                    }
                    else if (point.bias == 1) {
                        cmp = 1;
                    }
                    else {
                        point.bias = -1;
                        continue;
                    }
                }
            }
            var cmp2 = isInsert ? cmp : Range.comparePoints(point, end);
            if (cmp2 > 0) {
                point.row += rowShift;
                point.column += point.row == end.row ? colShift : 0;
                continue;
            }
            if (!isInsert && cmp2 <= 0) {
                point.row = start.row;
                point.column = start.column;
                if (cmp2 === 0)
                    point.bias = 1;
            }
        }
    };
    var Marker = function (cm, id, row, column) {
        this.cm = cm;
        this.id = id;
        this.row = row;
        this.column = column;
        cm.marks[this.id] = this;
    };
    Marker.prototype.clear = function () { delete this.cm.marks[this.id]; };
    Marker.prototype.find = function () { return toCmPos(this); };
    this.setBookmark = function (cursor, options) {
        var bm = new Marker(this, this.$uid++, cursor.line, cursor.ch);
        if (!options || !options.insertLeft)
            bm.$insertRight = true;
        this.marks[bm.id] = bm;
        return bm;
    };
    this.moveH = function (increment, unit) {
        if (unit == 'char') {
            var sel = this.ace.selection;
            sel.clearSelection();
            sel.moveCursorBy(0, increment);
        }
    };
    this.findPosV = function (start, amount, unit, goalColumn) {
        if (unit == 'page') {
            var renderer = this.ace.renderer;
            var config = renderer.layerConfig;
            amount = amount * Math.floor(config.height / config.lineHeight);
            unit = 'line';
        }
        if (unit == 'line') {
            var screenPos = this.ace.session.documentToScreenPosition(start.line, start.ch);
            if (goalColumn != null)
                screenPos.column = goalColumn;
            screenPos.row += amount;
            screenPos.row = Math.min(Math.max(0, screenPos.row), this.ace.session.getScreenLength() - 1);
            var pos = this.ace.session.screenToDocumentPosition(screenPos.row, screenPos.column);
            return toCmPos(pos);
        }
        else {
            debugger;
        }
    };
    this.charCoords = function (pos, mode) {
        if (mode == 'div' || !mode) {
            var sc = this.ace.session.documentToScreenPosition(pos.line, pos.ch);
            return { left: sc.column, top: sc.row };
        }
        if (mode == 'local') {
            var renderer = this.ace.renderer;
            var sc = this.ace.session.documentToScreenPosition(pos.line, pos.ch);
            var lh = renderer.layerConfig.lineHeight;
            var cw = renderer.layerConfig.characterWidth;
            var top = lh * sc.row;
            return { left: sc.column * cw, top: top, bottom: top + lh };
        }
    };
    this.coordsChar = function (pos, mode) {
        var renderer = this.ace.renderer;
        if (mode == 'local') {
            var row = Math.max(0, Math.floor(pos.top / renderer.lineHeight));
            var col = Math.max(0, Math.floor(pos.left / renderer.characterWidth));
            var ch = renderer.session.screenToDocumentPosition(row, col);
            return toCmPos(ch);
        }
        else if (mode == 'div') {
            throw "not implemented";
        }
    };
    this.getSearchCursor = function (query, pos, caseFold) {
        var caseSensitive = false;
        var isRegexp = false;
        if (query instanceof RegExp && !query.global) {
            caseSensitive = !query.ignoreCase;
            query = query.source;
            isRegexp = true;
        }
        if (query == "\\n") {
            query = "\n";
            isRegexp = false;
        }
        var search = new Search();
        if (pos.ch == undefined)
            pos.ch = Number.MAX_VALUE;
        var acePos = { row: pos.line, column: pos.ch };
        var cm = this;
        var last = null;
        return {
            findNext: function () { return this.find(false); },
            findPrevious: function () { return this.find(true); },
            find: function (back) {
                search.setOptions({
                    needle: query,
                    caseSensitive: caseSensitive,
                    wrap: false,
                    backwards: back,
                    regExp: isRegexp,
                    start: last || acePos
                });
                var range = search.find(cm.ace.session);
                last = range;
                return last && [!last.isEmpty()];
            },
            from: function () { return last && toCmPos(last.start); },
            to: function () { return last && toCmPos(last.end); },
            replace: function (text) {
                if (last) {
                    last.end = cm.ace.session.doc.replace(last, text);
                }
            }
        };
    };
    this.scrollTo = function (x, y) {
        var renderer = this.ace.renderer;
        var config = renderer.layerConfig;
        var maxHeight = config.maxHeight;
        maxHeight -= (renderer.$size.scrollerHeight - renderer.lineHeight) * renderer.$scrollPastEnd;
        if (y != null)
            this.ace.session.setScrollTop(Math.max(0, Math.min(y, maxHeight)));
        if (x != null)
            this.ace.session.setScrollLeft(Math.max(0, Math.min(x, config.width)));
    };
    this.scrollInfo = function () { return 0; };
    this.scrollIntoView = function (pos, margin) {
        if (pos) {
            var renderer = this.ace.renderer;
            var viewMargin = { "top": 0, "bottom": margin };
            renderer.scrollCursorIntoView(toAcePos(pos), (renderer.lineHeight * 2) / renderer.$size.scrollerHeight, viewMargin);
        }
    };
    this.getLine = function (row) { return this.ace.session.getLine(row); };
    this.getRange = function (s, e) {
        return this.ace.session.getTextRange(new Range(s.line, s.ch, e.line, e.ch));
    };
    this.replaceRange = function (text, s, e) {
        if (!e)
            e = s;
        var range = new Range(s.line, s.ch, e.line, e.ch);
        this.ace.session.$clipRangeToDocument(range);
        return this.ace.session.replace(range, text);
    };
    this.replaceSelection =
        this.replaceSelections = function (p) {
            var strings = Array.isArray(p) && p;
            var sel = this.ace.selection;
            if (this.ace.inVirtualSelectionMode) {
                this.ace.session.replace(sel.getRange(), strings ? p[0] || "" : p);
                return;
            }
            sel.inVirtualSelectionMode = true;
            var ranges = sel.rangeList.ranges;
            if (!ranges.length)
                ranges = [this.ace.multiSelect.getRange()];
            for (var i = ranges.length; i--;)
                this.ace.session.replace(ranges[i], strings ? p[i] || "" : p);
            sel.inVirtualSelectionMode = false;
        };
    this.getSelection = function () {
        return this.ace.getSelectedText();
    };
    this.getSelections = function () {
        return this.listSelections().map(function (x) {
            return this.getRange(x.anchor, x.head);
        }, this);
    };
    this.getInputField = function () {
        return this.ace.textInput.getElement();
    };
    this.getWrapperElement = function () {
        return this.ace.container;
    };
    var optMap = {
        indentWithTabs: "useSoftTabs",
        indentUnit: "tabSize",
        tabSize: "tabSize",
        firstLineNumber: "firstLineNumber",
        readOnly: "readOnly"
    };
    this.setOption = function (name, val) {
        this.state[name] = val;
        switch (name) {
            case 'indentWithTabs':
                name = optMap[name];
                val = !val;
                break;
            case 'keyMap':
                this.state.$keyMap = val;
                return;
                break;
            default:
                name = optMap[name];
        }
        if (name)
            this.ace.setOption(name, val);
    };
    this.getOption = function (name) {
        var val;
        var aceOpt = optMap[name];
        if (aceOpt)
            val = this.ace.getOption(aceOpt);
        switch (name) {
            case 'indentWithTabs':
                name = optMap[name];
                return !val;
            case 'keyMap':
                return this.state.$keyMap || 'vim';
        }
        return aceOpt ? val : this.state[name];
    };
    this.toggleOverwrite = function (on) {
        this.state.overwrite = on;
        return this.ace.setOverwrite(on);
    };
    this.addOverlay = function (o) {
        if (!this.$searchHighlight || !this.$searchHighlight.session) {
            var highlight = new SearchHighlight(null, "ace_highlight-marker", "text");
            var marker = this.ace.session.addDynamicMarker(highlight);
            highlight.id = marker.id;
            highlight.session = this.ace.session;
            highlight.destroy = function (o) {
                highlight.session.off("change", highlight.updateOnChange);
                highlight.session.off("changeEditor", highlight.destroy);
                highlight.session.removeMarker(highlight.id);
                highlight.session = null;
            };
            highlight.updateOnChange = function (delta) {
                var row = delta.start.row;
                if (row == delta.end.row)
                    highlight.cache[row] = undefined;
                else
                    highlight.cache.splice(row, highlight.cache.length);
            };
            highlight.session.on("changeEditor", highlight.destroy);
            highlight.session.on("change", highlight.updateOnChange);
        }
        var re = new RegExp(o.query.source, "gmi");
        this.$searchHighlight = o.highlight = highlight;
        this.$searchHighlight.setRegexp(re);
        this.ace.renderer.updateBackMarkers();
    };
    this.removeOverlay = function (o) {
        if (this.$searchHighlight && this.$searchHighlight.session) {
            this.$searchHighlight.destroy();
        }
    };
    this.getScrollInfo = function () {
        var renderer = this.ace.renderer;
        var config = renderer.layerConfig;
        return {
            left: renderer.scrollLeft,
            top: renderer.scrollTop,
            height: config.maxHeight,
            width: config.width,
            clientHeight: config.height,
            clientWidth: config.width
        };
    };
    this.getValue = function () {
        return this.ace.getValue();
    };
    this.setValue = function (v) {
        return this.ace.setValue(v, -1);
    };
    this.getTokenTypeAt = function (pos) {
        var token = this.ace.session.getTokenAt(pos.line, pos.ch);
        return token && /comment|string/.test(token.type) ? "string" : "";
    };
    this.findMatchingBracket = function (pos) {
        var m = this.ace.session.findMatchingBracket(toAcePos(pos));
        return { to: m && toCmPos(m) };
    };
    this.findMatchingTag = function (pos) {
        var m = this.ace.session.getMatchingTags(toAcePos(pos));
        if (!m)
            return;
        return {
            open: {
                from: toCmPos(m.openTag.start),
                to: toCmPos(m.openTag.end)
            },
            close: {
                from: toCmPos(m.closeTag.start),
                to: toCmPos(m.closeTag.end)
            }
        };
    };
    this.indentLine = function (line, method) {
        if (method === true)
            this.ace.session.indentRows(line, line, "\t");
        else if (method === false)
            this.ace.session.outdentRows(new Range(line, 0, line, 0));
    };
    this.indexFromPos = function (pos) {
        return this.ace.session.doc.positionToIndex(toAcePos(pos));
    };
    this.posFromIndex = function (index) {
        return toCmPos(this.ace.session.doc.indexToPosition(index));
    };
    this.focus = function (index) {
        return this.ace.textInput.focus();
    };
    this.blur = function (index) {
        return this.ace.blur();
    };
    this.defaultTextHeight = function (index) {
        return this.ace.renderer.layerConfig.lineHeight;
    };
    this.scanForBracket = function (pos, dir, _, options) {
        var re = options.bracketRegex.source;
        var tokenRe = /paren|text|operator|tag/;
        if (dir == 1) {
            var m = this.ace.session.$findClosingBracket(re.slice(1, 2), toAcePos(pos), tokenRe);
        }
        else {
            var m = this.ace.session.$findOpeningBracket(re.slice(-2, -1), { row: pos.line, column: pos.ch + 1 }, tokenRe);
            if (!m && options.bracketRegex && options.bracketRegex.test(this.getLine(pos.line)[pos.ch - 1])) {
                m = { row: pos.line, column: pos.ch - 1 };
            }
        }
        return m && { pos: toCmPos(m) };
    };
    this.refresh = function () {
        return this.ace.resize(true);
    };
    this.getMode = function () {
        return { name: this.getOption("mode") };
    };
    this.execCommand = function (name) {
        if (CodeMirror.commands.hasOwnProperty(name))
            return CodeMirror.commands[name](this);
        if (name == "indentAuto")
            return this.ace.execCommand("autoindent");
        console.log(name + " is not implemented");
    };
    this.getLineNumber = function (handle) {
        var deltas = this.$lineHandleChanges;
        if (!deltas)
            return null;
        var row = handle.row;
        for (var i = 0; i < deltas.length; i++) {
            var delta = deltas[i];
            if (delta.start.row != delta.end.row) {
                if (delta.action[0] == "i") {
                    if (delta.start.row < row)
                        row += delta.end.row - delta.start.row;
                }
                else {
                    if (delta.start.row < row) {
                        if (row < delta.end.row || row == delta.end.row && delta.start.column > 0) {
                            return null;
                        }
                        row -= delta.end.row - delta.start.row;
                    }
                }
            }
        }
        return row;
    };
    this.getLineHandle = function (row) {
        if (!this.$lineHandleChanges)
            this.$lineHandleChanges = [];
        return { text: this.ace.session.getLine(row), row: row };
    };
    this.releaseLineHandles = function () {
        this.$lineHandleChanges = undefined;
    };
    this.getLastEditEnd = function () {
        var undoManager = this.ace.session.$undoManager;
        if (undoManager && undoManager.$lastDelta)
            return toCmPos(undoManager.$lastDelta.end);
    };
}).call(CodeMirror.prototype);
function toAcePos(cmPos) {
    return { row: cmPos.line, column: cmPos.ch };
}
function toCmPos(acePos) {
    return new Pos(acePos.row, acePos.column);
}
var StringStream = CodeMirror.StringStream = function (string, tabSize) {
    this.pos = this.start = 0;
    this.string = string;
    this.tabSize = tabSize || 8;
    this.lastColumnPos = this.lastColumnValue = 0;
    this.lineStart = 0;
};
StringStream.prototype = {
    eol: function () { return this.pos >= this.string.length; },
    sol: function () { return this.pos == this.lineStart; },
    peek: function () { return this.string.charAt(this.pos) || undefined; },
    next: function () {
        if (this.pos < this.string.length)
            return this.string.charAt(this.pos++);
    },
    eat: function (match) {
        var ch = this.string.charAt(this.pos);
        if (typeof match == "string")
            var ok = ch == match;
        else
            var ok = ch && (match.test ? match.test(ch) : match(ch));
        if (ok) {
            ++this.pos;
            return ch;
        }
    },
    eatWhile: function (match) {
        var start = this.pos;
        while (this.eat(match)) { }
        return this.pos > start;
    },
    eatSpace: function () {
        var start = this.pos;
        while (/[\s\u00a0]/.test(this.string.charAt(this.pos)))
            ++this.pos;
        return this.pos > start;
    },
    skipToEnd: function () { this.pos = this.string.length; },
    skipTo: function (ch) {
        var found = this.string.indexOf(ch, this.pos);
        if (found > -1) {
            this.pos = found;
            return true;
        }
    },
    backUp: function (n) { this.pos -= n; },
    column: function () {
        throw "not implemented";
    },
    indentation: function () {
        throw "not implemented";
    },
    match: function (pattern, consume, caseInsensitive) {
        if (typeof pattern == "string") {
            var cased = function (str) { return caseInsensitive ? str.toLowerCase() : str; };
            var substr = this.string.substr(this.pos, pattern.length);
            if (cased(substr) == cased(pattern)) {
                if (consume !== false)
                    this.pos += pattern.length;
                return true;
            }
        }
        else {
            var match = this.string.slice(this.pos).match(pattern);
            if (match && match.index > 0)
                return null;
            if (match && consume !== false)
                this.pos += match[0].length;
            return match;
        }
    },
    current: function () { return this.string.slice(this.start, this.pos); },
    hideFirstChars: function (n, inner) {
        this.lineStart += n;
        try {
            return inner();
        }
        finally {
            this.lineStart -= n;
        }
    }
};
CodeMirror.defineExtension = function (name, fn) {
    CodeMirror.prototype[name] = fn;
};
domLib.importCssString(".normal-mode .ace_cursor{\n    border: none;\n    background-color: rgba(255,0,0,0.5);\n}\n.normal-mode .ace_hidden-cursors .ace_cursor{\n  background-color: transparent;\n  border: 1px solid red;\n  opacity: 0.7\n}\n.ace_dialog {\n  position: absolute;\n  left: 0; right: 0;\n  background: inherit;\n  z-index: 15;\n  padding: .1em .8em;\n  overflow: hidden;\n  color: inherit;\n}\n.ace_dialog-top {\n  border-bottom: 1px solid #444;\n  top: 0;\n}\n.ace_dialog-bottom {\n  border-top: 1px solid #444;\n  bottom: 0;\n}\n.ace_dialog input {\n  border: none;\n  outline: none;\n  background: transparent;\n  width: 20em;\n  color: inherit;\n  font-family: monospace;\n}", "vimMode", false);
(function () {
    function dialogDiv(cm, template, bottom) {
        var wrap = cm.ace.container;
        var dialog;
        dialog = wrap.appendChild(document.createElement("div"));
        if (bottom)
            dialog.className = "ace_dialog ace_dialog-bottom";
        else
            dialog.className = "ace_dialog ace_dialog-top";
        if (typeof template == "string") {
            dialog.innerHTML = template;
        }
        else { // Assuming it's a detached DOM element.
            dialog.appendChild(template);
        }
        return dialog;
    }
    function closeNotification(cm, newVal) {
        if (cm.state.currentNotificationClose)
            cm.state.currentNotificationClose();
        cm.state.currentNotificationClose = newVal;
    }
    CodeMirror.defineExtension("openDialog", function (template, callback, options) {
        if (this.virtualSelectionMode())
            return;
        if (!options)
            options = {};
        closeNotification(this, null);
        var dialog = dialogDiv(this, template, options.bottom);
        var closed = false, me = this;
        this.state.dialog = dialog;
        function close(newVal) {
            if (typeof newVal == 'string') {
                inp.value = newVal;
            }
            else {
                if (closed)
                    return;
                if (newVal && newVal.type == "blur") {
                    if (document.activeElement === inp)
                        return;
                }
                if (me.state.dialog == dialog) {
                    me.state.dialog = null;
                    me.focus();
                }
                closed = true;
                dialog.remove();
                if (options.onClose)
                    options.onClose(dialog);
                var cm = me;
                if (cm.state.vim) {
                    cm.state.vim.status = null;
                    cm.ace._signal("changeStatus");
                    cm.ace.renderer.$loop.schedule(cm.ace.renderer.CHANGE_CURSOR);
                }
            }
        }
        var inp = dialog.getElementsByTagName("input")[0], button;
        if (inp) {
            if (options.value) {
                inp.value = options.value;
                if (options.selectValueOnOpen !== false)
                    inp.select();
            }
            if (options.onInput)
                CodeMirror.on(inp, "input", function (e) { options.onInput(e, inp.value, close); });
            if (options.onKeyUp)
                CodeMirror.on(inp, "keyup", function (e) { options.onKeyUp(e, inp.value, close); });
            CodeMirror.on(inp, "keydown", function (e) {
                if (options && options.onKeyDown && options.onKeyDown(e, inp.value, close)) {
                    return;
                }
                if (e.keyCode == 13)
                    callback(inp.value);
                if (e.keyCode == 27 || (options.closeOnEnter !== false && e.keyCode == 13)) {
                    CodeMirror.e_stop(e);
                    close();
                }
            });
            if (options.closeOnBlur !== false)
                CodeMirror.on(inp, "blur", close);
            inp.focus();
        }
        else if (button = dialog.getElementsByTagName("button")[0]) {
            CodeMirror.on(button, "click", function () {
                close();
                me.focus();
            });
            if (options.closeOnBlur !== false)
                CodeMirror.on(button, "blur", close);
            button.focus();
        }
        return close;
    });
    CodeMirror.defineExtension("openNotification", function (template, options) {
        if (this.virtualSelectionMode())
            return;
        closeNotification(this, close);
        var dialog = dialogDiv(this, template, options && options.bottom);
        var closed = false, doneTimer;
        var duration = options && typeof options.duration !== "undefined" ? options.duration : 5000;
        function close() {
            if (closed)
                return;
            closed = true;
            clearTimeout(doneTimer);
            dialog.remove();
        }
        CodeMirror.on(dialog, 'click', function (e) {
            CodeMirror.e_preventDefault(e);
            close();
        });
        if (duration)
            doneTimer = setTimeout(close, duration);
        return close;
    });
})();
var Pos = CodeMirror.Pos;
function updateSelectionForSurrogateCharacters(cm, curStart, curEnd) {
    if (curStart.line === curEnd.line && curStart.ch >= curEnd.ch - 1) {
        var text = cm.getLine(curStart.line);
        var charCode = text.charCodeAt(curStart.ch);
        if (0xD800 <= charCode && charCode <= 0xD8FF) {
            curEnd.ch += 1;
        }
    }
    return { start: curStart, end: curEnd };
}
var defaultKeymap = [
    { keys: '<Left>', type: 'keyToKey', toKeys: 'h' },
    { keys: '<Right>', type: 'keyToKey', toKeys: 'l' },
    { keys: '<Up>', type: 'keyToKey', toKeys: 'k' },
    { keys: '<Down>', type: 'keyToKey', toKeys: 'j' },
    { keys: 'g<Up>', type: 'keyToKey', toKeys: 'gk' },
    { keys: 'g<Down>', type: 'keyToKey', toKeys: 'gj' },
    { keys: '<Space>', type: 'keyToKey', toKeys: 'l' },
    { keys: '<BS>', type: 'keyToKey', toKeys: 'h' },
    { keys: '<Del>', type: 'keyToKey', toKeys: 'x' },
    { keys: '<C-Space>', type: 'keyToKey', toKeys: 'W' },
    { keys: '<C-BS>', type: 'keyToKey', toKeys: 'B' },
    { keys: '<S-Space>', type: 'keyToKey', toKeys: 'w' },
    { keys: '<S-BS>', type: 'keyToKey', toKeys: 'b' },
    { keys: '<C-n>', type: 'keyToKey', toKeys: 'j' },
    { keys: '<C-p>', type: 'keyToKey', toKeys: 'k' },
    { keys: '<C-[>', type: 'keyToKey', toKeys: '<Esc>' },
    { keys: '<C-c>', type: 'keyToKey', toKeys: '<Esc>' },
    { keys: '<C-[>', type: 'keyToKey', toKeys: '<Esc>', context: 'insert' },
    { keys: '<C-c>', type: 'keyToKey', toKeys: '<Esc>', context: 'insert' },
    { keys: '<C-Esc>', type: 'keyToKey', toKeys: '<Esc>' }, // ipad keyboard sends C-Esc instead of C-[
    { keys: '<C-Esc>', type: 'keyToKey', toKeys: '<Esc>', context: 'insert' },
    { keys: 's', type: 'keyToKey', toKeys: 'cl', context: 'normal' },
    { keys: 's', type: 'keyToKey', toKeys: 'c', context: 'visual' },
    { keys: 'S', type: 'keyToKey', toKeys: 'cc', context: 'normal' },
    { keys: 'S', type: 'keyToKey', toKeys: 'VdO', context: 'visual' },
    { keys: '<Home>', type: 'keyToKey', toKeys: '0' },
    { keys: '<End>', type: 'keyToKey', toKeys: '$' },
    { keys: '<PageUp>', type: 'keyToKey', toKeys: '<C-b>' },
    { keys: '<PageDown>', type: 'keyToKey', toKeys: '<C-f>' },
    { keys: '<CR>', type: 'keyToKey', toKeys: 'j^', context: 'normal' },
    { keys: '<Ins>', type: 'keyToKey', toKeys: 'i', context: 'normal' },
    { keys: '<Ins>', type: 'action', action: 'toggleOverwrite', context: 'insert' },
    { keys: 'H', type: 'motion', motion: 'moveToTopLine', motionArgs: { linewise: true, toJumplist: true } },
    { keys: 'M', type: 'motion', motion: 'moveToMiddleLine', motionArgs: { linewise: true, toJumplist: true } },
    { keys: 'L', type: 'motion', motion: 'moveToBottomLine', motionArgs: { linewise: true, toJumplist: true } },
    { keys: 'h', type: 'motion', motion: 'moveByCharacters', motionArgs: { forward: false } },
    { keys: 'l', type: 'motion', motion: 'moveByCharacters', motionArgs: { forward: true } },
    { keys: 'j', type: 'motion', motion: 'moveByLines', motionArgs: { forward: true, linewise: true } },
    { keys: 'k', type: 'motion', motion: 'moveByLines', motionArgs: { forward: false, linewise: true } },
    { keys: 'gj', type: 'motion', motion: 'moveByDisplayLines', motionArgs: { forward: true } },
    { keys: 'gk', type: 'motion', motion: 'moveByDisplayLines', motionArgs: { forward: false } },
    { keys: 'w', type: 'motion', motion: 'moveByWords', motionArgs: { forward: true, wordEnd: false } },
    { keys: 'W', type: 'motion', motion: 'moveByWords', motionArgs: { forward: true, wordEnd: false, bigWord: true } },
    { keys: 'e', type: 'motion', motion: 'moveByWords', motionArgs: { forward: true, wordEnd: true, inclusive: true } },
    { keys: 'E', type: 'motion', motion: 'moveByWords', motionArgs: { forward: true, wordEnd: true, bigWord: true, inclusive: true } },
    { keys: 'b', type: 'motion', motion: 'moveByWords', motionArgs: { forward: false, wordEnd: false } },
    { keys: 'B', type: 'motion', motion: 'moveByWords', motionArgs: { forward: false, wordEnd: false, bigWord: true } },
    { keys: 'ge', type: 'motion', motion: 'moveByWords', motionArgs: { forward: false, wordEnd: true, inclusive: true } },
    { keys: 'gE', type: 'motion', motion: 'moveByWords', motionArgs: { forward: false, wordEnd: true, bigWord: true, inclusive: true } },
    { keys: '{', type: 'motion', motion: 'moveByParagraph', motionArgs: { forward: false, toJumplist: true } },
    { keys: '}', type: 'motion', motion: 'moveByParagraph', motionArgs: { forward: true, toJumplist: true } },
    { keys: '(', type: 'motion', motion: 'moveBySentence', motionArgs: { forward: false } },
    { keys: ')', type: 'motion', motion: 'moveBySentence', motionArgs: { forward: true } },
    { keys: '<C-f>', type: 'motion', motion: 'moveByPage', motionArgs: { forward: true } },
    { keys: '<C-b>', type: 'motion', motion: 'moveByPage', motionArgs: { forward: false } },
    { keys: '<C-d>', type: 'motion', motion: 'moveByScroll', motionArgs: { forward: true, explicitRepeat: true } },
    { keys: '<C-u>', type: 'motion', motion: 'moveByScroll', motionArgs: { forward: false, explicitRepeat: true } },
    { keys: 'gg', type: 'motion', motion: 'moveToLineOrEdgeOfDocument', motionArgs: { forward: false, explicitRepeat: true, linewise: true, toJumplist: true } },
    { keys: 'G', type: 'motion', motion: 'moveToLineOrEdgeOfDocument', motionArgs: { forward: true, explicitRepeat: true, linewise: true, toJumplist: true } },
    { keys: "g$", type: "motion", motion: "moveToEndOfDisplayLine" },
    { keys: "g^", type: "motion", motion: "moveToStartOfDisplayLine" },
    { keys: "g0", type: "motion", motion: "moveToStartOfDisplayLine" },
    { keys: '0', type: 'motion', motion: 'moveToStartOfLine' },
    { keys: '^', type: 'motion', motion: 'moveToFirstNonWhiteSpaceCharacter' },
    { keys: '+', type: 'motion', motion: 'moveByLines', motionArgs: { forward: true, toFirstChar: true } },
    { keys: '-', type: 'motion', motion: 'moveByLines', motionArgs: { forward: false, toFirstChar: true } },
    { keys: '_', type: 'motion', motion: 'moveByLines', motionArgs: { forward: true, toFirstChar: true, repeatOffset: -1 } },
    { keys: '$', type: 'motion', motion: 'moveToEol', motionArgs: { inclusive: true } },
    { keys: '%', type: 'motion', motion: 'moveToMatchedSymbol', motionArgs: { inclusive: true, toJumplist: true } },
    { keys: 'f<character>', type: 'motion', motion: 'moveToCharacter', motionArgs: { forward: true, inclusive: true } },
    { keys: 'F<character>', type: 'motion', motion: 'moveToCharacter', motionArgs: { forward: false } },
    { keys: 't<character>', type: 'motion', motion: 'moveTillCharacter', motionArgs: { forward: true, inclusive: true } },
    { keys: 'T<character>', type: 'motion', motion: 'moveTillCharacter', motionArgs: { forward: false } },
    { keys: ';', type: 'motion', motion: 'repeatLastCharacterSearch', motionArgs: { forward: true } },
    { keys: ',', type: 'motion', motion: 'repeatLastCharacterSearch', motionArgs: { forward: false } },
    { keys: '\'<register>', type: 'motion', motion: 'goToMark', motionArgs: { toJumplist: true, linewise: true } },
    { keys: '`<register>', type: 'motion', motion: 'goToMark', motionArgs: { toJumplist: true } },
    { keys: ']`', type: 'motion', motion: 'jumpToMark', motionArgs: { forward: true } },
    { keys: '[`', type: 'motion', motion: 'jumpToMark', motionArgs: { forward: false } },
    { keys: ']\'', type: 'motion', motion: 'jumpToMark', motionArgs: { forward: true, linewise: true } },
    { keys: '[\'', type: 'motion', motion: 'jumpToMark', motionArgs: { forward: false, linewise: true } },
    { keys: ']p', type: 'action', action: 'paste', isEdit: true, actionArgs: { after: true, isEdit: true, matchIndent: true } },
    { keys: '[p', type: 'action', action: 'paste', isEdit: true, actionArgs: { after: false, isEdit: true, matchIndent: true } },
    { keys: ']<character>', type: 'motion', motion: 'moveToSymbol', motionArgs: { forward: true, toJumplist: true } },
    { keys: '[<character>', type: 'motion', motion: 'moveToSymbol', motionArgs: { forward: false, toJumplist: true } },
    { keys: '|', type: 'motion', motion: 'moveToColumn' },
    { keys: 'o', type: 'motion', motion: 'moveToOtherHighlightedEnd', context: 'visual' },
    { keys: 'O', type: 'motion', motion: 'moveToOtherHighlightedEnd', motionArgs: { sameLine: true }, context: 'visual' },
    { keys: 'd', type: 'operator', operator: 'delete' },
    { keys: 'y', type: 'operator', operator: 'yank' },
    { keys: 'c', type: 'operator', operator: 'change' },
    { keys: '=', type: 'operator', operator: 'indentAuto' },
    { keys: '>', type: 'operator', operator: 'indent', operatorArgs: { indentRight: true } },
    { keys: '<', type: 'operator', operator: 'indent', operatorArgs: { indentRight: false } },
    { keys: 'g~', type: 'operator', operator: 'changeCase' },
    { keys: 'gu', type: 'operator', operator: 'changeCase', operatorArgs: { toLower: true }, isEdit: true },
    { keys: 'gU', type: 'operator', operator: 'changeCase', operatorArgs: { toLower: false }, isEdit: true },
    { keys: 'n', type: 'motion', motion: 'findNext', motionArgs: { forward: true, toJumplist: true } },
    { keys: 'N', type: 'motion', motion: 'findNext', motionArgs: { forward: false, toJumplist: true } },
    { keys: 'gn', type: 'motion', motion: 'findAndSelectNextInclusive', motionArgs: { forward: true } },
    { keys: 'gN', type: 'motion', motion: 'findAndSelectNextInclusive', motionArgs: { forward: false } },
    { keys: 'gq', type: 'operator', operator: 'hardWrap' },
    { keys: 'gw', type: 'operator', operator: 'hardWrap', operatorArgs: { keepCursor: true } },
    { keys: 'x', type: 'operatorMotion', operator: 'delete', motion: 'moveByCharacters', motionArgs: { forward: true }, operatorMotionArgs: { visualLine: false } },
    { keys: 'X', type: 'operatorMotion', operator: 'delete', motion: 'moveByCharacters', motionArgs: { forward: false }, operatorMotionArgs: { visualLine: true } },
    { keys: 'D', type: 'operatorMotion', operator: 'delete', motion: 'moveToEol', motionArgs: { inclusive: true }, context: 'normal' },
    { keys: 'D', type: 'operator', operator: 'delete', operatorArgs: { linewise: true }, context: 'visual' },
    { keys: 'Y', type: 'operatorMotion', operator: 'yank', motion: 'expandToLine', motionArgs: { linewise: true }, context: 'normal' },
    { keys: 'Y', type: 'operator', operator: 'yank', operatorArgs: { linewise: true }, context: 'visual' },
    { keys: 'C', type: 'operatorMotion', operator: 'change', motion: 'moveToEol', motionArgs: { inclusive: true }, context: 'normal' },
    { keys: 'C', type: 'operator', operator: 'change', operatorArgs: { linewise: true }, context: 'visual' },
    { keys: '~', type: 'operatorMotion', operator: 'changeCase', motion: 'moveByCharacters', motionArgs: { forward: true }, operatorArgs: { shouldMoveCursor: true }, context: 'normal' },
    { keys: '~', type: 'operator', operator: 'changeCase', context: 'visual' },
    { keys: '<C-u>', type: 'operatorMotion', operator: 'delete', motion: 'moveToStartOfLine', context: 'insert' },
    { keys: '<C-w>', type: 'operatorMotion', operator: 'delete', motion: 'moveByWords', motionArgs: { forward: false, wordEnd: false }, context: 'insert' },
    { keys: '<C-w>', type: 'idle', context: 'normal' },
    { keys: '<C-i>', type: 'action', action: 'jumpListWalk', actionArgs: { forward: true } },
    { keys: '<C-o>', type: 'action', action: 'jumpListWalk', actionArgs: { forward: false } },
    { keys: '<C-e>', type: 'action', action: 'scroll', actionArgs: { forward: true, linewise: true } },
    { keys: '<C-y>', type: 'action', action: 'scroll', actionArgs: { forward: false, linewise: true } },
    { keys: 'a', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { insertAt: 'charAfter' }, context: 'normal' },
    { keys: 'A', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { insertAt: 'eol' }, context: 'normal' },
    { keys: 'A', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { insertAt: 'endOfSelectedArea' }, context: 'visual' },
    { keys: 'i', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { insertAt: 'inplace' }, context: 'normal' },
    { keys: 'gi', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { insertAt: 'lastEdit' }, context: 'normal' },
    { keys: 'I', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { insertAt: 'firstNonBlank' }, context: 'normal' },
    { keys: 'gI', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { insertAt: 'bol' }, context: 'normal' },
    { keys: 'I', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { insertAt: 'startOfSelectedArea' }, context: 'visual' },
    { keys: 'o', type: 'action', action: 'newLineAndEnterInsertMode', isEdit: true, interlaceInsertRepeat: true, actionArgs: { after: true }, context: 'normal' },
    { keys: 'O', type: 'action', action: 'newLineAndEnterInsertMode', isEdit: true, interlaceInsertRepeat: true, actionArgs: { after: false }, context: 'normal' },
    { keys: 'v', type: 'action', action: 'toggleVisualMode' },
    { keys: 'V', type: 'action', action: 'toggleVisualMode', actionArgs: { linewise: true } },
    { keys: '<C-v>', type: 'action', action: 'toggleVisualMode', actionArgs: { blockwise: true } },
    { keys: '<C-q>', type: 'action', action: 'toggleVisualMode', actionArgs: { blockwise: true } },
    { keys: 'gv', type: 'action', action: 'reselectLastSelection' },
    { keys: 'J', type: 'action', action: 'joinLines', isEdit: true },
    { keys: 'gJ', type: 'action', action: 'joinLines', actionArgs: { keepSpaces: true }, isEdit: true },
    { keys: 'p', type: 'action', action: 'paste', isEdit: true, actionArgs: { after: true, isEdit: true } },
    { keys: 'P', type: 'action', action: 'paste', isEdit: true, actionArgs: { after: false, isEdit: true } },
    { keys: 'r<character>', type: 'action', action: 'replace', isEdit: true },
    { keys: '@<register>', type: 'action', action: 'replayMacro' },
    { keys: 'q<register>', type: 'action', action: 'enterMacroRecordMode' },
    { keys: 'R', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { replace: true }, context: 'normal' },
    { keys: 'R', type: 'operator', operator: 'change', operatorArgs: { linewise: true, fullLine: true }, context: 'visual', exitVisualBlock: true },
    { keys: 'u', type: 'action', action: 'undo', context: 'normal' },
    { keys: 'u', type: 'operator', operator: 'changeCase', operatorArgs: { toLower: true }, context: 'visual', isEdit: true },
    { keys: 'U', type: 'operator', operator: 'changeCase', operatorArgs: { toLower: false }, context: 'visual', isEdit: true },
    { keys: '<C-r>', type: 'action', action: 'redo' },
    { keys: 'm<register>', type: 'action', action: 'setMark' },
    { keys: '"<register>', type: 'action', action: 'setRegister' },
    { keys: '<C-r><register>', type: 'action', action: 'insertRegister', context: 'insert', isEdit: true },
    { keys: '<C-o>', type: 'action', action: 'oneNormalCommand', context: 'insert' },
    { keys: 'zz', type: 'action', action: 'scrollToCursor', actionArgs: { position: 'center' } },
    { keys: 'z.', type: 'action', action: 'scrollToCursor', actionArgs: { position: 'center' }, motion: 'moveToFirstNonWhiteSpaceCharacter' },
    { keys: 'zt', type: 'action', action: 'scrollToCursor', actionArgs: { position: 'top' } },
    { keys: 'z<CR>', type: 'action', action: 'scrollToCursor', actionArgs: { position: 'top' }, motion: 'moveToFirstNonWhiteSpaceCharacter' },
    { keys: 'zb', type: 'action', action: 'scrollToCursor', actionArgs: { position: 'bottom' } },
    { keys: 'z-', type: 'action', action: 'scrollToCursor', actionArgs: { position: 'bottom' }, motion: 'moveToFirstNonWhiteSpaceCharacter' },
    { keys: '.', type: 'action', action: 'repeatLastEdit' },
    { keys: '<C-a>', type: 'action', action: 'incrementNumberToken', isEdit: true, actionArgs: { increase: true, backtrack: false } },
    { keys: '<C-x>', type: 'action', action: 'incrementNumberToken', isEdit: true, actionArgs: { increase: false, backtrack: false } },
    { keys: '<C-t>', type: 'action', action: 'indent', actionArgs: { indentRight: true }, context: 'insert' },
    { keys: '<C-d>', type: 'action', action: 'indent', actionArgs: { indentRight: false }, context: 'insert' },
    { keys: 'a<register>', type: 'motion', motion: 'textObjectManipulation' },
    { keys: 'i<register>', type: 'motion', motion: 'textObjectManipulation', motionArgs: { textObjectInner: true } },
    { keys: '/', type: 'search', searchArgs: { forward: true, querySrc: 'prompt', toJumplist: true } },
    { keys: '?', type: 'search', searchArgs: { forward: false, querySrc: 'prompt', toJumplist: true } },
    { keys: '*', type: 'search', searchArgs: { forward: true, querySrc: 'wordUnderCursor', wholeWordOnly: true, toJumplist: true } },
    { keys: '#', type: 'search', searchArgs: { forward: false, querySrc: 'wordUnderCursor', wholeWordOnly: true, toJumplist: true } },
    { keys: 'g*', type: 'search', searchArgs: { forward: true, querySrc: 'wordUnderCursor', toJumplist: true } },
    { keys: 'g#', type: 'search', searchArgs: { forward: false, querySrc: 'wordUnderCursor', toJumplist: true } },
    { keys: ':', type: 'ex' }
];
var defaultKeymapLength = defaultKeymap.length;
var defaultExCommandMap = [
    { name: 'colorscheme', shortName: 'colo' },
    { name: 'map' },
    { name: 'imap', shortName: 'im' },
    { name: 'nmap', shortName: 'nm' },
    { name: 'vmap', shortName: 'vm' },
    { name: 'omap', shortName: 'om' },
    { name: 'noremap', shortName: 'no' },
    { name: 'nnoremap', shortName: 'nn' },
    { name: 'vnoremap', shortName: 'vn' },
    { name: 'inoremap', shortName: 'ino' },
    { name: 'onoremap', shortName: 'ono' },
    { name: 'unmap' },
    { name: 'mapclear', shortName: 'mapc' },
    { name: 'nmapclear', shortName: 'nmapc' },
    { name: 'vmapclear', shortName: 'vmapc' },
    { name: 'imapclear', shortName: 'imapc' },
    { name: 'omapclear', shortName: 'omapc' },
    { name: 'write', shortName: 'w' },
    { name: 'undo', shortName: 'u' },
    { name: 'redo', shortName: 'red' },
    { name: 'set', shortName: 'se' },
    { name: 'setlocal', shortName: 'setl' },
    { name: 'setglobal', shortName: 'setg' },
    { name: 'sort', shortName: 'sor' },
    { name: 'substitute', shortName: 's', possiblyAsync: true },
    { name: 'startinsert', shortName: 'start' },
    { name: 'nohlsearch', shortName: 'noh' },
    { name: 'yank', shortName: 'y' },
    { name: 'delmarks', shortName: 'delm' },
    { name: 'registers', shortName: 'reg', excludeFromCommandHistory: true },
    { name: 'vglobal', shortName: 'v' },
    { name: 'delete', shortName: 'd' },
    { name: 'join', shortName: 'j' },
    { name: 'normal', shortName: 'norm' },
    { name: 'global', shortName: 'g' }
];
var langmap = parseLangmap('');
function enterVimMode(cm) {
    cm.setOption('disableInput', true);
    cm.setOption('showCursorWhenSelecting', false);
    CodeMirror.signal(cm, "vim-mode-change", { mode: "normal" });
    cm.on('cursorActivity', onCursorActivity);
    maybeInitVimState(cm);
    CodeMirror.on(cm.getInputField(), 'paste', getOnPasteFn(cm));
}
function leaveVimMode(cm) {
    cm.setOption('disableInput', false);
    cm.off('cursorActivity', onCursorActivity);
    CodeMirror.off(cm.getInputField(), 'paste', getOnPasteFn(cm));
    cm.state.vim = null;
    if (highlightTimeout)
        clearTimeout(highlightTimeout);
}
function getOnPasteFn(cm) {
    var vim = cm.state.vim;
    if (!vim.onPasteFn) {
        vim.onPasteFn = function () {
            if (!vim.insertMode) {
                cm.setCursor(offsetCursor(cm.getCursor(), 0, 1));
                actions.enterInsertMode(cm, {}, vim);
            }
        };
    }
    return vim.onPasteFn;
}
var numberRegex = /[\d]/;
var wordCharTest = [CodeMirror.isWordChar, function (ch) {
        return ch && !CodeMirror.isWordChar(ch) && !/\s/.test(ch);
    }], bigWordCharTest = [function (ch) {
        return /\S/.test(ch);
    }];
var validMarks = ['<', '>'];
var validRegisters = ['-', '"', '.', ':', '_', '/', '+'];
var latinCharRegex = /^\w$/;
var upperCaseChars;
try {
    upperCaseChars = new RegExp("^[\\p{Lu}]$", "u");
}
catch (_) {
    upperCaseChars = /^[A-Z]$/;
}
function isLine(cm, line) {
    return line >= cm.firstLine() && line <= cm.lastLine();
}
function isLowerCase(k) {
    return (/^[a-z]$/).test(k);
}
function isMatchableSymbol(k) {
    return '()[]{}'.indexOf(k) != -1;
}
function isNumber(k) {
    return numberRegex.test(k);
}
function isUpperCase(k) {
    return upperCaseChars.test(k);
}
function isWhiteSpaceString(k) {
    return (/^\s*$/).test(k);
}
function isEndOfSentenceSymbol(k) {
    return '.?!'.indexOf(k) != -1;
}
function inArray(val, arr) {
    for (var i = 0; i < arr.length; i++) {
        if (arr[i] == val) {
            return true;
        }
    }
    return false;
}
var options = {};
function defineOption(name, defaultValue, type, aliases, callback) {
    if (defaultValue === undefined && !callback) {
        throw Error('defaultValue is required unless callback is provided');
    }
    if (!type) {
        type = 'string';
    }
    options[name] = {
        type: type,
        defaultValue: defaultValue,
        callback: callback
    };
    if (aliases) {
        for (var i = 0; i < aliases.length; i++) {
            options[aliases[i]] = options[name];
        }
    }
    if (defaultValue) {
        setOption(name, defaultValue);
    }
}
function setOption(name, value, cm, cfg) {
    var option = options[name];
    cfg = cfg || {};
    var scope = cfg.scope;
    if (!option) {
        return new Error('Unknown option: ' + name);
    }
    if (option.type == 'boolean') {
        if (value && value !== true) {
            return new Error('Invalid argument: ' + name + '=' + value);
        }
        else if (value !== false) {
            value = true;
        }
    }
    if (option.callback) {
        if (scope !== 'local') {
            option.callback(value, undefined);
        }
        if (scope !== 'global' && cm) {
            option.callback(value, cm);
        }
    }
    else {
        if (scope !== 'local') {
            option.value = option.type == 'boolean' ? !!value : value;
        }
        if (scope !== 'global' && cm) {
            cm.state.vim.options[name] = { value: value };
        }
    }
}
function getOption(name, cm, cfg) {
    var option = options[name];
    cfg = cfg || {};
    var scope = cfg.scope;
    if (!option) {
        return new Error('Unknown option: ' + name);
    }
    if (option.callback) {
        var local = cm && option.callback(undefined, cm);
        if (scope !== 'global' && local !== undefined) {
            return local;
        }
        if (scope !== 'local') {
            return option.callback();
        }
        return;
    }
    else {
        var local = (scope !== 'global') && (cm && cm.state.vim.options[name]);
        return (local || (scope !== 'local') && option || {}).value;
    }
}
defineOption('filetype', undefined, 'string', ['ft'], function (name, cm) {
    if (cm === undefined) {
        return;
    }
    if (name === undefined) {
        var mode = cm.getOption('mode');
        return mode == 'null' ? '' : mode;
    }
    else {
        var mode = name == '' ? 'null' : name;
        cm.setOption('mode', mode);
    }
});
defineOption('textwidth', 80, 'number', ['tw'], function (width, cm) {
    if (cm === undefined) {
        return;
    }
    if (width === undefined) {
        var value = cm.getOption('textwidth');
        return value;
    }
    else {
        var column = Math.round(width);
        if (column > 1) {
            cm.setOption('textwidth', column);
        }
    }
});
var createCircularJumpList = function () {
    var size = 100;
    var pointer = -1;
    var head = 0;
    var tail = 0;
    var buffer = new Array(size);
    function add(cm, oldCur, newCur) {
        var current = pointer % size;
        var curMark = buffer[current];
        function useNextSlot(cursor) {
            var next = ++pointer % size;
            var trashMark = buffer[next];
            if (trashMark) {
                trashMark.clear();
            }
            buffer[next] = cm.setBookmark(cursor);
        }
        if (curMark) {
            var markPos = curMark.find();
            if (markPos && !cursorEqual(markPos, oldCur)) {
                useNextSlot(oldCur);
            }
        }
        else {
            useNextSlot(oldCur);
        }
        useNextSlot(newCur);
        head = pointer;
        tail = pointer - size + 1;
        if (tail < 0) {
            tail = 0;
        }
    }
    function move(cm, offset) {
        pointer += offset;
        if (pointer > head) {
            pointer = head;
        }
        else if (pointer < tail) {
            pointer = tail;
        }
        var mark = buffer[(size + pointer) % size];
        if (mark && !mark.find()) {
            var inc = offset > 0 ? 1 : -1;
            var newCur;
            var oldCur = cm.getCursor();
            do {
                pointer += inc;
                mark = buffer[(size + pointer) % size];
                if (mark &&
                    (newCur = mark.find()) &&
                    !cursorEqual(oldCur, newCur)) {
                    break;
                }
            } while (pointer < head && pointer > tail);
        }
        return mark;
    }
    function find(cm, offset) {
        var oldPointer = pointer;
        var mark = move(cm, offset);
        pointer = oldPointer;
        return mark && mark.find();
    }
    return {
        cachedCursor: undefined, //used for # and * jumps
        add: add,
        find: find,
        move: move
    };
};
var createInsertModeChanges = function (c) {
    if (c) {
        return {
            changes: c.changes,
            expectCursorActivityForChange: c.expectCursorActivityForChange
        };
    }
    return {
        changes: [],
        expectCursorActivityForChange: false
    };
};
function MacroModeState() {
    this.latestRegister = undefined;
    this.isPlaying = false;
    this.isRecording = false;
    this.replaySearchQueries = [];
    this.onRecordingDone = undefined;
    this.lastInsertModeChanges = createInsertModeChanges();
}
MacroModeState.prototype = {
    exitMacroRecordMode: function () {
        var macroModeState = vimGlobalState.macroModeState;
        if (macroModeState.onRecordingDone) {
            macroModeState.onRecordingDone(); // close dialog
        }
        macroModeState.onRecordingDone = undefined;
        macroModeState.isRecording = false;
    },
    enterMacroRecordMode: function (cm, registerName) {
        var register = vimGlobalState.registerController.getRegister(registerName);
        if (register) {
            register.clear();
            this.latestRegister = registerName;
            if (cm.openDialog) {
                var template = dom('span', { class: 'cm-vim-message' }, 'recording @' + registerName);
                this.onRecordingDone = cm.openDialog(template, null, { bottom: true });
            }
            this.isRecording = true;
        }
    }
};
function maybeInitVimState(cm) {
    if (!cm.state.vim) {
        cm.state.vim = {
            inputState: new InputState(),
            lastEditInputState: undefined,
            lastEditActionCommand: undefined,
            lastHPos: -1,
            lastHSPos: -1,
            lastMotion: null,
            marks: {},
            insertMode: false,
            insertModeReturn: false,
            insertModeRepeat: undefined,
            visualMode: false,
            visualLine: false,
            visualBlock: false,
            lastSelection: null,
            lastPastedText: null,
            sel: {},
            options: {},
            expectLiteralNext: false
        };
    }
    return cm.state.vim;
}
var vimGlobalState;
function resetVimGlobalState() {
    vimGlobalState = {
        searchQuery: null,
        searchIsReversed: false,
        lastSubstituteReplacePart: undefined,
        jumpList: createCircularJumpList(),
        macroModeState: new MacroModeState,
        lastCharacterSearch: { increment: 0, forward: true, selectedCharacter: '' },
        registerController: new RegisterController({}),
        searchHistoryController: new HistoryController(),
        exCommandHistoryController: new HistoryController()
    };
    for (var optionName in options) {
        var option = options[optionName];
        option.value = option.defaultValue;
    }
}
var lastInsertModeKeyTimer;
var vimApi = {
    enterVimMode: enterVimMode,
    leaveVimMode: leaveVimMode,
    buildKeyMap: function () {
    },
    getRegisterController: function () {
        return vimGlobalState.registerController;
    },
    resetVimGlobalState_: resetVimGlobalState,
    getVimGlobalState_: function () {
        return vimGlobalState;
    },
    maybeInitVimState_: maybeInitVimState,
    suppressErrorLogging: false,
    InsertModeKey: InsertModeKey,
    map: function (lhs, rhs, ctx) {
        exCommandDispatcher.map(lhs, rhs, ctx);
    },
    unmap: function (lhs, ctx) {
        return exCommandDispatcher.unmap(lhs, ctx);
    },
    noremap: function (lhs, rhs, ctx) {
        exCommandDispatcher.map(lhs, rhs, ctx, true);
    },
    mapclear: function (ctx) {
        var actualLength = defaultKeymap.length, origLength = defaultKeymapLength;
        var userKeymap = defaultKeymap.slice(0, actualLength - origLength);
        defaultKeymap = defaultKeymap.slice(actualLength - origLength);
        if (ctx) {
            for (var i = userKeymap.length - 1; i >= 0; i--) {
                var mapping = userKeymap[i];
                if (ctx !== mapping.context) {
                    if (mapping.context) {
                        this._mapCommand(mapping);
                    }
                    else {
                        var contexts = ['normal', 'insert', 'visual'];
                        for (var j in contexts) {
                            if (contexts[j] !== ctx) {
                                var newMapping = {};
                                for (var key in mapping) {
                                    newMapping[key] = mapping[key];
                                }
                                newMapping.context = contexts[j];
                                this._mapCommand(newMapping);
                            }
                        }
                    }
                }
            }
        }
    },
    langmap: updateLangmap,
    vimKeyFromEvent: vimKeyFromEvent,
    setOption: setOption,
    getOption: getOption,
    defineOption: defineOption,
    defineEx: function (name, prefix, func) {
        if (!prefix) {
            prefix = name;
        }
        else if (name.indexOf(prefix) !== 0) {
            throw new Error('(Vim.defineEx) "' + prefix + '" is not a prefix of "' + name + '", command not registered');
        }
        exCommands[name] = func;
        exCommandDispatcher.commandMap_[prefix] = { name: name, shortName: prefix, type: 'api' };
    },
    handleKey: function (cm, key, origin) {
        var command = this.findKey(cm, key, origin);
        if (typeof command === 'function') {
            return command();
        }
    },
    multiSelectHandleKey: multiSelectHandleKey,
    findKey: function (cm, key, origin) {
        var vim = maybeInitVimState(cm);
        function handleMacroRecording() {
            var macroModeState = vimGlobalState.macroModeState;
            if (macroModeState.isRecording) {
                if (key == 'q') {
                    macroModeState.exitMacroRecordMode();
                    clearInputState(cm);
                    return true;
                }
                if (origin != 'mapping') {
                    logKey(macroModeState, key);
                }
            }
        }
        function handleEsc() {
            if (key == '<Esc>') {
                if (vim.visualMode) {
                    exitVisualMode(cm);
                }
                else if (vim.insertMode) {
                    exitInsertMode(cm);
                }
                else {
                    return;
                }
                clearInputState(cm);
                return true;
            }
        }
        function handleKeyInsertMode() {
            if (handleEsc()) {
                return true;
            }
            vim.inputState.keyBuffer.push(key);
            var keys = vim.inputState.keyBuffer.join("");
            var keysAreChars = key.length == 1;
            var match = commandDispatcher.matchCommand(keys, defaultKeymap, vim.inputState, 'insert');
            var changeQueue = vim.inputState.changeQueue;
            if (match.type == 'none') {
                clearInputState(cm);
                return false;
            }
            else if (match.type == 'partial') {
                if (match.expectLiteralNext)
                    vim.expectLiteralNext = true;
                if (lastInsertModeKeyTimer) {
                    window.clearTimeout(lastInsertModeKeyTimer);
                }
                lastInsertModeKeyTimer = keysAreChars && window.setTimeout(function () { if (vim.insertMode && vim.inputState.keyBuffer.length) {
                    clearInputState(cm);
                } }, getOption('insertModeEscKeysTimeout'));
                if (keysAreChars) {
                    var selections = cm.listSelections();
                    if (!changeQueue || changeQueue.removed.length != selections.length)
                        changeQueue = vim.inputState.changeQueue = new ChangeQueue;
                    changeQueue.inserted += key;
                    for (var i = 0; i < selections.length; i++) {
                        var from = cursorMin(selections[i].anchor, selections[i].head);
                        var to = cursorMax(selections[i].anchor, selections[i].head);
                        var text = cm.getRange(from, cm.state.overwrite ? offsetCursor(to, 0, 1) : to);
                        changeQueue.removed[i] = (changeQueue.removed[i] || "") + text;
                    }
                }
                return !keysAreChars;
            }
            vim.expectLiteralNext = false;
            if (lastInsertModeKeyTimer) {
                window.clearTimeout(lastInsertModeKeyTimer);
            }
            if (match.command && changeQueue) {
                var selections = cm.listSelections();
                for (var i = 0; i < selections.length; i++) {
                    var here = selections[i].head;
                    cm.replaceRange(changeQueue.removed[i] || "", offsetCursor(here, 0, -changeQueue.inserted.length), here, '+input');
                }
                vimGlobalState.macroModeState.lastInsertModeChanges.changes.pop();
            }
            if (!match.command)
                clearInputState(cm);
            return match.command;
        }
        function handleKeyNonInsertMode() {
            if (handleMacroRecording() || handleEsc()) {
                return true;
            }
            vim.inputState.keyBuffer.push(key);
            var keys = vim.inputState.keyBuffer.join("");
            if (/^[1-9]\d*$/.test(keys)) {
                return true;
            }
            var keysMatcher = /^(\d*)(.*)$/.exec(keys);
            if (!keysMatcher) {
                clearInputState(cm);
                return false;
            }
            var context = vim.visualMode ? 'visual' :
                'normal';
            var mainKey = keysMatcher[2] || keysMatcher[1];
            if (vim.inputState.operatorShortcut && vim.inputState.operatorShortcut.slice(-1) == mainKey) {
                mainKey = vim.inputState.operatorShortcut;
            }
            var match = commandDispatcher.matchCommand(mainKey, defaultKeymap, vim.inputState, context);
            if (match.type == 'none') {
                clearInputState(cm);
                return false;
            }
            else if (match.type == 'partial') {
                if (match.expectLiteralNext)
                    vim.expectLiteralNext = true;
                return true;
            }
            else if (match.type == 'clear') {
                clearInputState(cm);
                return true;
            }
            vim.expectLiteralNext = false;
            vim.inputState.keyBuffer.length = 0;
            keysMatcher = /^(\d*)(.*)$/.exec(keys);
            if (keysMatcher[1] && keysMatcher[1] != '0') {
                vim.inputState.pushRepeatDigit(keysMatcher[1]);
            }
            return match.command;
        }
        var command;
        if (vim.insertMode) {
            command = handleKeyInsertMode();
        }
        else {
            command = handleKeyNonInsertMode();
        }
        if (command === false) {
            return !vim.insertMode && key.length === 1 ? function () { return true; } : undefined;
        }
        else if (command === true) {
            return function () { return true; };
        }
        else {
            return function () {
                if ((command.operator || command.isEdit) && cm.getOption('readOnly'))
                    return; // ace_patch
                return cm.operation(function () {
                    cm.curOp.isVimOp = true;
                    try {
                        if (command.type == 'keyToKey') {
                            doKeyToKey(cm, command.toKeys, command);
                        }
                        else {
                            commandDispatcher.processCommand(cm, vim, command);
                        }
                    }
                    catch (e) {
                        cm.state.vim = undefined;
                        maybeInitVimState(cm);
                        if (!vimApi.suppressErrorLogging) {
                            console['log'](e);
                        }
                        throw e;
                    }
                    return true;
                });
            };
        }
    },
    handleEx: function (cm, input) {
        exCommandDispatcher.processCommand(cm, input);
    },
    defineMotion: defineMotion,
    defineAction: defineAction,
    defineOperator: defineOperator,
    mapCommand: mapCommand,
    _mapCommand: _mapCommand,
    defineRegister: defineRegister,
    exitVisualMode: exitVisualMode,
    exitInsertMode: exitInsertMode
};
var keyToKeyStack = [];
var noremap = false;
var virtualPrompt;
function sendKeyToPrompt(key) {
    if (key[0] == "<") {
        var lowerKey = key.toLowerCase().slice(1, -1);
        var parts = lowerKey.split('-');
        lowerKey = parts.pop() || '';
        if (lowerKey == 'lt')
            key = '<';
        else if (lowerKey == 'space')
            key = ' ';
        else if (lowerKey == 'cr')
            key = '\n';
        else if (vimToCmKeyMap[lowerKey]) {
            var value = virtualPrompt.value;
            var event = {
                key: vimToCmKeyMap[lowerKey],
                target: {
                    value: value,
                    selectionEnd: value.length,
                    selectionStart: value.length
                }
            };
            if (virtualPrompt.onKeyDown) {
                virtualPrompt.onKeyDown(event, virtualPrompt.value, close);
            }
            if (virtualPrompt && virtualPrompt.onKeyUp) {
                virtualPrompt.onKeyUp(event, virtualPrompt.value, close);
            }
            return;
        }
    }
    if (key == '\n') {
        var prompt = virtualPrompt;
        virtualPrompt = null;
        prompt.onClose && prompt.onClose(prompt.value);
    }
    else {
        virtualPrompt.value = (virtualPrompt.value || '') + key;
    }
    function close(value) {
        if (typeof value == 'string') {
            virtualPrompt.value = value;
        }
        else {
            virtualPrompt = null;
        }
    }
}
function doKeyToKey(cm, keys, fromKey) {
    var noremapBefore = noremap;
    if (fromKey) {
        if (keyToKeyStack.indexOf(fromKey) != -1)
            return;
        keyToKeyStack.push(fromKey);
        noremap = fromKey.noremap != false;
    }
    try {
        var vim = maybeInitVimState(cm);
        var keyRe = /<(?:[CSMA]-)*\w+>|./gi;
        var match;
        while ((match = keyRe.exec(keys))) {
            var key = match[0];
            var wasInsert = vim.insertMode;
            if (virtualPrompt) {
                sendKeyToPrompt(key);
                continue;
            }
            var result = vimApi.handleKey(cm, key, 'mapping');
            if (!result && wasInsert && vim.insertMode) {
                if (key[0] == "<") {
                    var lowerKey = key.toLowerCase().slice(1, -1);
                    var parts = lowerKey.split('-');
                    lowerKey = parts.pop() || '';
                    if (lowerKey == 'lt')
                        key = '<';
                    else if (lowerKey == 'space')
                        key = ' ';
                    else if (lowerKey == 'cr')
                        key = '\n';
                    else if (vimToCmKeyMap.hasOwnProperty(lowerKey)) {
                        key = vimToCmKeyMap[lowerKey];
                        sendCmKey(cm, key);
                        continue;
                    }
                    else {
                        key = key[0];
                        keyRe.lastIndex = match.index + 1;
                    }
                }
                cm.replaceSelection(key);
            }
        }
    }
    finally {
        keyToKeyStack.pop();
        noremap = keyToKeyStack.length ? noremapBefore : false;
        if (!keyToKeyStack.length && virtualPrompt) {
            var promptOptions = virtualPrompt;
            virtualPrompt = null;
            showPrompt(cm, promptOptions);
        }
    }
}
var specialKey = {
    Return: 'CR', Backspace: 'BS', 'Delete': 'Del', Escape: 'Esc', Insert: 'Ins',
    ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
    Enter: 'CR', ' ': 'Space'
};
var ignoredKeys = { Shift: 1, Alt: 1, Command: 1, Control: 1,
    CapsLock: 1, AltGraph: 1, Dead: 1, Unidentified: 1 };
var vimToCmKeyMap = {};
'Left|Right|Up|Down|End|Home'.split('|').concat(Object.keys(specialKey)).forEach(function (x) {
    vimToCmKeyMap[(specialKey[x] || '').toLowerCase()]
        = vimToCmKeyMap[x.toLowerCase()] = x;
});
function vimKeyFromEvent(e, vim) {
    var key = e.key;
    if (ignoredKeys[key])
        return;
    if (key.length > 1 && key[0] == "n") {
        key = key.replace("Numpad", "");
    }
    key = specialKey[key] || key;
    var name = '';
    if (e.ctrlKey) {
        name += 'C-';
    }
    if (e.altKey) {
        name += 'A-';
    }
    if (e.metaKey) {
        name += 'M-';
    }
    if (CodeMirror.isMac && e.altKey && !e.metaKey && !e.ctrlKey) {
        name = name.slice(2);
    }
    if ((name || key.length > 1) && e.shiftKey) {
        name += 'S-';
    }
    if (vim && !vim.expectLiteralNext && key.length == 1) {
        if (langmap.keymap && key in langmap.keymap) {
            if (langmap.remapCtrl != false || !name)
                key = langmap.keymap[key];
        }
        else if (key.charCodeAt(0) > 255) {
            var code = e.code && e.code.slice(-1) || "";
            if (!e.shiftKey)
                code = code.toLowerCase();
            if (code)
                key = code;
        }
    }
    name += key;
    if (name.length > 1) {
        name = '<' + name + '>';
    }
    return name;
}
;
function updateLangmap(langmapString, remapCtrl) {
    if (langmap.string !== langmapString) {
        langmap = parseLangmap(langmapString);
    }
    langmap.remapCtrl = remapCtrl;
}
function parseLangmap(langmapString) {
    var keymap = {};
    if (!langmapString)
        return { keymap: keymap, string: '' };
    function getEscaped(list) {
        return list.split(/\\?(.)/).filter(Boolean);
    }
    langmapString.split(/((?:[^\\,]|\\.)+),/).map(function (part) {
        if (!part)
            return;
        var semicolon = part.split(/((?:[^\\;]|\\.)+);/);
        if (semicolon.length == 3) {
            var from = getEscaped(semicolon[1]);
            var to = getEscaped(semicolon[2]);
            if (from.length !== to.length)
                return; // skip over malformed part
            for (var i = 0; i < from.length; ++i)
                keymap[from[i]] = to[i];
        }
        else if (semicolon.length == 1) {
            var pairs = getEscaped(part);
            if (pairs.length % 2 !== 0)
                return; // skip over malformed part
            for (var i = 0; i < pairs.length; i += 2)
                keymap[pairs[i]] = pairs[i + 1];
        }
    });
    return { keymap: keymap, string: langmapString };
}
defineOption('langmap', undefined, 'string', ['lmap'], function (name, cm) {
    if (name === undefined) {
        return langmap.string;
    }
    else {
        updateLangmap(name);
    }
});
function InputState() {
    this.prefixRepeat = [];
    this.motionRepeat = [];
    this.operator = null;
    this.operatorArgs = null;
    this.motion = null;
    this.motionArgs = null;
    this.keyBuffer = []; // For matching multi-key commands.
    this.registerName = null; // Defaults to the unnamed register.
    this.changeQueue = null; // For restoring text used by insert mode keybindings
}
InputState.prototype.pushRepeatDigit = function (n) {
    if (!this.operator) {
        this.prefixRepeat = this.prefixRepeat.concat(n);
    }
    else {
        this.motionRepeat = this.motionRepeat.concat(n);
    }
};
InputState.prototype.getRepeat = function () {
    var repeat = 0;
    if (this.prefixRepeat.length > 0 || this.motionRepeat.length > 0) {
        repeat = 1;
        if (this.prefixRepeat.length > 0) {
            repeat *= parseInt(this.prefixRepeat.join(''), 10);
        }
        if (this.motionRepeat.length > 0) {
            repeat *= parseInt(this.motionRepeat.join(''), 10);
        }
    }
    return repeat;
};
function clearInputState(cm, reason) {
    cm.state.vim.inputState = new InputState();
    cm.state.vim.expectLiteralNext = false;
    CodeMirror.signal(cm, 'vim-command-done', reason);
}
function ChangeQueue() {
    this.removed = [];
    this.inserted = "";
}
function Register(text, linewise, blockwise) {
    this.clear();
    this.keyBuffer = [text || ''];
    this.insertModeChanges = [];
    this.searchQueries = [];
    this.linewise = !!linewise;
    this.blockwise = !!blockwise;
}
Register.prototype = {
    setText: function (text, linewise, blockwise) {
        this.keyBuffer = [text || ''];
        this.linewise = !!linewise;
        this.blockwise = !!blockwise;
    },
    pushText: function (text, linewise) {
        if (linewise) {
            if (!this.linewise) {
                this.keyBuffer.push('\n');
            }
            this.linewise = true;
        }
        this.keyBuffer.push(text);
    },
    pushInsertModeChanges: function (changes) {
        this.insertModeChanges.push(createInsertModeChanges(changes));
    },
    pushSearchQuery: function (query) {
        this.searchQueries.push(query);
    },
    clear: function () {
        this.keyBuffer = [];
        this.insertModeChanges = [];
        this.searchQueries = [];
        this.linewise = false;
    },
    toString: function () {
        return this.keyBuffer.join('');
    }
};
function defineRegister(name, register) {
    var registers = vimGlobalState.registerController.registers;
    if (!name || name.length != 1) {
        throw Error('Register name must be 1 character');
    }
    registers[name] = register;
    validRegisters.push(name);
}
function RegisterController(registers) {
    this.registers = registers;
    this.unnamedRegister = registers['"'] = new Register();
    registers['.'] = new Register();
    registers[':'] = new Register();
    registers['/'] = new Register();
    registers['+'] = new Register();
}
RegisterController.prototype = {
    pushText: function (registerName, operator, text, linewise, blockwise) {
        if (registerName === '_')
            return;
        if (linewise && text.charAt(text.length - 1) !== '\n') {
            text += '\n';
        }
        var register = this.isValidRegister(registerName) ?
            this.getRegister(registerName) : null;
        if (!register) {
            switch (operator) {
                case 'yank':
                    this.registers['0'] = new Register(text, linewise, blockwise);
                    break;
                case 'delete':
                case 'change':
                    if (text.indexOf('\n') == -1) {
                        this.registers['-'] = new Register(text, linewise);
                    }
                    else {
                        this.shiftNumericRegisters_();
                        this.registers['1'] = new Register(text, linewise);
                    }
                    break;
            }
            this.unnamedRegister.setText(text, linewise, blockwise);
            return;
        }
        var append = isUpperCase(registerName);
        if (append) {
            register.pushText(text, linewise);
        }
        else {
            register.setText(text, linewise, blockwise);
        }
        if (registerName === '+' && typeof navigator !== 'undefined' &&
            typeof navigator.clipboard !== 'undefined' &&
            typeof navigator.clipboard.readText === 'function') {
            navigator.clipboard.writeText(text);
        }
        this.unnamedRegister.setText(register.toString(), linewise);
    },
    getRegister: function (name) {
        if (!this.isValidRegister(name)) {
            return this.unnamedRegister;
        }
        name = name.toLowerCase();
        if (!this.registers[name]) {
            this.registers[name] = new Register();
        }
        return this.registers[name];
    },
    isValidRegister: function (name) {
        return name && (inArray(name, validRegisters) || latinCharRegex.test(name));
    },
    shiftNumericRegisters_: function () {
        for (var i = 9; i >= 2; i--) {
            this.registers[i] = this.getRegister('' + (i - 1));
        }
    }
};
function HistoryController() {
    this.historyBuffer = [];
    this.iterator = 0;
    this.initialPrefix = null;
}
HistoryController.prototype = {
    nextMatch: function (input, up) {
        var historyBuffer = this.historyBuffer;
        var dir = up ? -1 : 1;
        if (this.initialPrefix === null)
            this.initialPrefix = input;
        for (var i = this.iterator + dir; up ? i >= 0 : i < historyBuffer.length; i += dir) {
            var element = historyBuffer[i];
            for (var j = 0; j <= element.length; j++) {
                if (this.initialPrefix == element.substring(0, j)) {
                    this.iterator = i;
                    return element;
                }
            }
        }
        if (i >= historyBuffer.length) {
            this.iterator = historyBuffer.length;
            return this.initialPrefix;
        }
        if (i < 0)
            return input;
    },
    pushInput: function (input) {
        var index = this.historyBuffer.indexOf(input);
        if (index > -1)
            this.historyBuffer.splice(index, 1);
        if (input.length)
            this.historyBuffer.push(input);
    },
    reset: function () {
        this.initialPrefix = null;
        this.iterator = this.historyBuffer.length;
    }
};
var commandDispatcher = {
    matchCommand: function (keys, keyMap, inputState, context) {
        var matches = commandMatches(keys, keyMap, context, inputState);
        if (!matches.full && !matches.partial) {
            return { type: 'none' };
        }
        else if (!matches.full && matches.partial) {
            return {
                type: 'partial',
                expectLiteralNext: matches.partial.length == 1 && matches.partial[0].keys.slice(-11) == '<character>' // langmap literal logic
            };
        }
        var bestMatch;
        for (var i = 0; i < matches.full.length; i++) {
            var match = matches.full[i];
            if (!bestMatch) {
                bestMatch = match;
            }
        }
        if (bestMatch.keys.slice(-11) == '<character>' || bestMatch.keys.slice(-10) == '<register>') {
            var character = lastChar(keys);
            if (!character || character.length > 1)
                return { type: 'clear' };
            inputState.selectedCharacter = character;
        }
        return { type: 'full', command: bestMatch };
    },
    processCommand: function (cm, vim, command) {
        vim.inputState.repeatOverride = command.repeatOverride;
        switch (command.type) {
            case 'motion':
                this.processMotion(cm, vim, command);
                break;
            case 'operator':
                this.processOperator(cm, vim, command);
                break;
            case 'operatorMotion':
                this.processOperatorMotion(cm, vim, command);
                break;
            case 'action':
                this.processAction(cm, vim, command);
                break;
            case 'search':
                this.processSearch(cm, vim, command);
                break;
            case 'ex':
            case 'keyToEx':
                this.processEx(cm, vim, command);
                break;
            default:
                break;
        }
    },
    processMotion: function (cm, vim, command) {
        vim.inputState.motion = command.motion;
        vim.inputState.motionArgs = copyArgs(command.motionArgs);
        this.evalInput(cm, vim);
    },
    processOperator: function (cm, vim, command) {
        var inputState = vim.inputState;
        if (inputState.operator) {
            if (inputState.operator == command.operator) {
                inputState.motion = 'expandToLine';
                inputState.motionArgs = { linewise: true };
                this.evalInput(cm, vim);
                return;
            }
            else {
                clearInputState(cm);
            }
        }
        inputState.operator = command.operator;
        inputState.operatorArgs = copyArgs(command.operatorArgs);
        if (command.keys.length > 1) {
            inputState.operatorShortcut = command.keys;
        }
        if (command.exitVisualBlock) {
            vim.visualBlock = false;
            updateCmSelection(cm);
        }
        if (vim.visualMode) {
            this.evalInput(cm, vim);
        }
    },
    processOperatorMotion: function (cm, vim, command) {
        var visualMode = vim.visualMode;
        var operatorMotionArgs = copyArgs(command.operatorMotionArgs);
        if (operatorMotionArgs) {
            if (visualMode && operatorMotionArgs.visualLine) {
                vim.visualLine = true;
            }
        }
        this.processOperator(cm, vim, command);
        if (!visualMode) {
            this.processMotion(cm, vim, command);
        }
    },
    processAction: function (cm, vim, command) {
        var inputState = vim.inputState;
        var repeat = inputState.getRepeat();
        var repeatIsExplicit = !!repeat;
        var actionArgs = copyArgs(command.actionArgs) || {};
        if (inputState.selectedCharacter) {
            actionArgs.selectedCharacter = inputState.selectedCharacter;
        }
        if (command.operator) {
            this.processOperator(cm, vim, command);
        }
        if (command.motion) {
            this.processMotion(cm, vim, command);
        }
        if (command.motion || command.operator) {
            this.evalInput(cm, vim);
        }
        actionArgs.repeat = repeat || 1;
        actionArgs.repeatIsExplicit = repeatIsExplicit;
        actionArgs.registerName = inputState.registerName;
        clearInputState(cm);
        vim.lastMotion = null;
        if (command.isEdit) {
            this.recordLastEdit(vim, inputState, command);
        }
        actions[command.action](cm, actionArgs, vim);
    },
    processSearch: function (cm, vim, command) {
        if (!cm.getSearchCursor) {
            return;
        }
        var forward = command.searchArgs.forward;
        var wholeWordOnly = command.searchArgs.wholeWordOnly;
        getSearchState(cm).setReversed(!forward);
        var promptPrefix = (forward) ? '/' : '?';
        var originalQuery = getSearchState(cm).getQuery();
        var originalScrollPos = cm.getScrollInfo();
        function handleQuery(query, ignoreCase, smartCase) {
            vimGlobalState.searchHistoryController.pushInput(query);
            vimGlobalState.searchHistoryController.reset();
            try {
                updateSearchQuery(cm, query, ignoreCase, smartCase);
            }
            catch (e) {
                showConfirm(cm, 'Invalid regex: ' + query);
                clearInputState(cm);
                return;
            }
            commandDispatcher.processMotion(cm, vim, {
                type: 'motion',
                motion: 'findNext',
                motionArgs: { forward: true, toJumplist: command.searchArgs.toJumplist }
            });
        }
        function onPromptClose(query) {
            handleQuery(query, true /** ignoreCase */, true /** smartCase */);
            var macroModeState = vimGlobalState.macroModeState;
            if (macroModeState.isRecording) {
                logSearchQuery(macroModeState, query);
            }
        }
        function onPromptKeyUp(e, query, close) {
            var keyName = vimKeyFromEvent(e), up, offset;
            if (keyName == '<Up>' || keyName == '<Down>') {
                up = keyName == '<Up>' ? true : false;
                offset = e.target ? e.target.selectionEnd : 0;
                query = vimGlobalState.searchHistoryController.nextMatch(query, up) || '';
                close(query);
                if (offset && e.target)
                    e.target.selectionEnd = e.target.selectionStart = Math.min(offset, e.target.value.length);
            }
            else if (keyName && keyName != '<Left>' && keyName != '<Right>') {
                vimGlobalState.searchHistoryController.reset();
            }
            var parsedQuery;
            try {
                parsedQuery = updateSearchQuery(cm, query, true /** ignoreCase */, true /** smartCase */);
            }
            catch (e) {
            }
            if (parsedQuery) {
                cm.scrollIntoView(findNext(cm, !forward, parsedQuery), 30);
            }
            else {
                clearSearchHighlight(cm);
                cm.scrollTo(originalScrollPos.left, originalScrollPos.top);
            }
        }
        function onPromptKeyDown(e, query, close) {
            var keyName = vimKeyFromEvent(e);
            if (keyName == '<Esc>' || keyName == '<C-c>' || keyName == '<C-[>' ||
                (keyName == '<BS>' && query == '')) {
                vimGlobalState.searchHistoryController.pushInput(query);
                vimGlobalState.searchHistoryController.reset();
                updateSearchQuery(cm, originalQuery);
                clearSearchHighlight(cm);
                cm.scrollTo(originalScrollPos.left, originalScrollPos.top);
                CodeMirror.e_stop(e);
                clearInputState(cm);
                close();
                cm.focus();
            }
            else if (keyName == '<Up>' || keyName == '<Down>') {
                CodeMirror.e_stop(e);
            }
            else if (keyName == '<C-u>') {
                CodeMirror.e_stop(e);
                close('');
            }
        }
        switch (command.searchArgs.querySrc) {
            case 'prompt':
                var macroModeState = vimGlobalState.macroModeState;
                if (macroModeState.isPlaying) {
                    var query = macroModeState.replaySearchQueries.shift();
                    handleQuery(query, true /** ignoreCase */, false /** smartCase */);
                }
                else {
                    showPrompt(cm, {
                        onClose: onPromptClose,
                        prefix: promptPrefix,
                        desc: '(JavaScript regexp)',
                        onKeyUp: onPromptKeyUp,
                        onKeyDown: onPromptKeyDown
                    });
                }
                break;
            case 'wordUnderCursor':
                var word = expandWordUnderCursor(cm, { noSymbol: true });
                var isKeyword = true;
                if (!word) {
                    word = expandWordUnderCursor(cm, { noSymbol: false });
                    isKeyword = false;
                }
                if (!word) {
                    showConfirm(cm, 'No word under cursor');
                    clearInputState(cm);
                    return;
                }
                var query = cm.getLine(word.start.line).substring(word.start.ch, word.end.ch);
                if (isKeyword && wholeWordOnly) {
                    query = '\\b' + query + '\\b';
                }
                else {
                    query = escapeRegex(query);
                }
                vimGlobalState.jumpList.cachedCursor = cm.getCursor();
                cm.setCursor(word.start);
                handleQuery(query, true /** ignoreCase */, false /** smartCase */);
                break;
        }
    },
    processEx: function (cm, vim, command) {
        function onPromptClose(input) {
            vimGlobalState.exCommandHistoryController.pushInput(input);
            vimGlobalState.exCommandHistoryController.reset();
            exCommandDispatcher.processCommand(cm, input);
            if (cm.state.vim)
                clearInputState(cm);
        }
        function onPromptKeyDown(e, input, close) {
            var keyName = vimKeyFromEvent(e), up, offset;
            if (keyName == '<Esc>' || keyName == '<C-c>' || keyName == '<C-[>' ||
                (keyName == '<BS>' && input == '')) {
                vimGlobalState.exCommandHistoryController.pushInput(input);
                vimGlobalState.exCommandHistoryController.reset();
                CodeMirror.e_stop(e);
                clearInputState(cm);
                close();
                cm.focus();
            }
            if (keyName == '<Up>' || keyName == '<Down>') {
                CodeMirror.e_stop(e);
                up = keyName == '<Up>' ? true : false;
                offset = e.target ? e.target.selectionEnd : 0;
                input = vimGlobalState.exCommandHistoryController.nextMatch(input, up) || '';
                close(input);
                if (offset && e.target)
                    e.target.selectionEnd = e.target.selectionStart = Math.min(offset, e.target.value.length);
            }
            else if (keyName == '<C-u>') {
                CodeMirror.e_stop(e);
                close('');
            }
            else if (keyName && keyName != '<Left>' && keyName != '<Right>') {
                vimGlobalState.exCommandHistoryController.reset();
            }
        }
        if (command.type == 'keyToEx') {
            exCommandDispatcher.processCommand(cm, command.exArgs.input);
        }
        else {
            if (vim.visualMode) {
                showPrompt(cm, { onClose: onPromptClose, prefix: ':', value: '\'<,\'>',
                    onKeyDown: onPromptKeyDown, selectValueOnOpen: false });
            }
            else {
                showPrompt(cm, { onClose: onPromptClose, prefix: ':',
                    onKeyDown: onPromptKeyDown });
            }
        }
    },
    evalInput: function (cm, vim) {
        var inputState = vim.inputState;
        var motion = inputState.motion;
        var motionArgs = inputState.motionArgs || {};
        var operator = inputState.operator;
        var operatorArgs = inputState.operatorArgs || {};
        var registerName = inputState.registerName;
        var sel = vim.sel;
        var origHead = copyCursor(vim.visualMode ? clipCursorToContent(cm, sel.head) : cm.getCursor('head'));
        var origAnchor = copyCursor(vim.visualMode ? clipCursorToContent(cm, sel.anchor) : cm.getCursor('anchor'));
        var oldHead = copyCursor(origHead);
        var oldAnchor = copyCursor(origAnchor);
        var newHead, newAnchor;
        var repeat;
        if (operator) {
            this.recordLastEdit(vim, inputState);
        }
        if (inputState.repeatOverride !== undefined) {
            repeat = inputState.repeatOverride;
        }
        else {
            repeat = inputState.getRepeat();
        }
        if (repeat > 0 && motionArgs.explicitRepeat) {
            motionArgs.repeatIsExplicit = true;
        }
        else if (motionArgs.noRepeat ||
            (!motionArgs.explicitRepeat && repeat === 0)) {
            repeat = 1;
            motionArgs.repeatIsExplicit = false;
        }
        if (inputState.selectedCharacter) {
            motionArgs.selectedCharacter = operatorArgs.selectedCharacter =
                inputState.selectedCharacter;
        }
        motionArgs.repeat = repeat;
        clearInputState(cm);
        if (motion) {
            var motionResult = motions[motion](cm, origHead, motionArgs, vim, inputState);
            vim.lastMotion = motions[motion];
            if (!motionResult) {
                return;
            }
            if (motionArgs.toJumplist) {
                if (!operator && cm.ace.curOp != null)
                    cm.ace.curOp.command.scrollIntoView = "center-animate"; // ace_patch
                var jumpList = vimGlobalState.jumpList;
                var cachedCursor = jumpList.cachedCursor;
                if (cachedCursor) {
                    recordJumpPosition(cm, cachedCursor, motionResult);
                    delete jumpList.cachedCursor;
                }
                else {
                    recordJumpPosition(cm, origHead, motionResult);
                }
            }
            if (motionResult instanceof Array) {
                newAnchor = motionResult[0];
                newHead = motionResult[1];
            }
            else {
                newHead = motionResult;
            }
            if (!newHead) {
                newHead = copyCursor(origHead);
            }
            if (vim.visualMode) {
                if (!(vim.visualBlock && newHead.ch === Infinity)) {
                    newHead = clipCursorToContent(cm, newHead, oldHead);
                }
                if (newAnchor) {
                    newAnchor = clipCursorToContent(cm, newAnchor);
                }
                newAnchor = newAnchor || oldAnchor;
                sel.anchor = newAnchor;
                sel.head = newHead;
                updateCmSelection(cm);
                updateMark(cm, vim, '<', cursorIsBefore(newAnchor, newHead) ? newAnchor
                    : newHead);
                updateMark(cm, vim, '>', cursorIsBefore(newAnchor, newHead) ? newHead
                    : newAnchor);
            }
            else if (!operator) {
                if (cm.ace.curOp)
                    cm.ace.curOp.vimDialogScroll = "center-animate"; // ace_patch
                newHead = clipCursorToContent(cm, newHead, oldHead);
                cm.setCursor(newHead.line, newHead.ch);
            }
        }
        if (operator) {
            if (operatorArgs.lastSel) {
                newAnchor = oldAnchor;
                var lastSel = operatorArgs.lastSel;
                var lineOffset = Math.abs(lastSel.head.line - lastSel.anchor.line);
                var chOffset = Math.abs(lastSel.head.ch - lastSel.anchor.ch);
                if (lastSel.visualLine) {
                    newHead = new Pos(oldAnchor.line + lineOffset, oldAnchor.ch);
                }
                else if (lastSel.visualBlock) {
                    newHead = new Pos(oldAnchor.line + lineOffset, oldAnchor.ch + chOffset);
                }
                else if (lastSel.head.line == lastSel.anchor.line) {
                    newHead = new Pos(oldAnchor.line, oldAnchor.ch + chOffset);
                }
                else {
                    newHead = new Pos(oldAnchor.line + lineOffset, oldAnchor.ch);
                }
                vim.visualMode = true;
                vim.visualLine = lastSel.visualLine;
                vim.visualBlock = lastSel.visualBlock;
                sel = vim.sel = {
                    anchor: newAnchor,
                    head: newHead
                };
                updateCmSelection(cm);
            }
            else if (vim.visualMode) {
                operatorArgs.lastSel = {
                    anchor: copyCursor(sel.anchor),
                    head: copyCursor(sel.head),
                    visualBlock: vim.visualBlock,
                    visualLine: vim.visualLine
                };
            }
            var curStart, curEnd, linewise, mode;
            var cmSel;
            if (vim.visualMode) {
                curStart = cursorMin(sel.head, sel.anchor);
                curEnd = cursorMax(sel.head, sel.anchor);
                linewise = vim.visualLine || operatorArgs.linewise;
                mode = vim.visualBlock ? 'block' :
                    linewise ? 'line' :
                        'char';
                var newPositions = updateSelectionForSurrogateCharacters(cm, curStart, curEnd);
                cmSel = makeCmSelection(cm, {
                    anchor: newPositions.start,
                    head: newPositions.end
                }, mode);
                if (linewise) {
                    var ranges = cmSel.ranges;
                    if (mode == 'block') {
                        for (var i = 0; i < ranges.length; i++) {
                            ranges[i].head.ch = lineLength(cm, ranges[i].head.line);
                        }
                    }
                    else if (mode == 'line') {
                        ranges[0].head = new Pos(ranges[0].head.line + 1, 0);
                    }
                }
            }
            else {
                curStart = copyCursor(newAnchor || oldAnchor);
                curEnd = copyCursor(newHead || oldHead);
                if (cursorIsBefore(curEnd, curStart)) {
                    var tmp = curStart;
                    curStart = curEnd;
                    curEnd = tmp;
                }
                linewise = motionArgs.linewise || operatorArgs.linewise;
                if (linewise) {
                    expandSelectionToLine(cm, curStart, curEnd);
                }
                else if (motionArgs.forward) {
                    clipToLine(cm, curStart, curEnd);
                }
                mode = 'char';
                var exclusive = !motionArgs.inclusive || linewise;
                var newPositions = updateSelectionForSurrogateCharacters(cm, curStart, curEnd);
                cmSel = makeCmSelection(cm, {
                    anchor: newPositions.start,
                    head: newPositions.end
                }, mode, exclusive);
            }
            cm.setSelections(cmSel.ranges, cmSel.primary);
            vim.lastMotion = null;
            operatorArgs.repeat = repeat; // For indent in visual mode.
            operatorArgs.registerName = registerName;
            operatorArgs.linewise = linewise;
            var operatorMoveTo = operators[operator](cm, operatorArgs, cmSel.ranges, oldAnchor, newHead);
            if (vim.visualMode) {
                exitVisualMode(cm, operatorMoveTo != null);
            }
            if (operatorMoveTo) {
                cm.setCursor(operatorMoveTo);
            }
        }
    },
    recordLastEdit: function (vim, inputState, actionCommand) {
        var macroModeState = vimGlobalState.macroModeState;
        if (macroModeState.isPlaying) {
            return;
        }
        vim.lastEditInputState = inputState;
        vim.lastEditActionCommand = actionCommand;
        macroModeState.lastInsertModeChanges.changes = [];
        macroModeState.lastInsertModeChanges.expectCursorActivityForChange = false;
        macroModeState.lastInsertModeChanges.visualBlock = vim.visualBlock ? vim.sel.head.line - vim.sel.anchor.line : 0;
    }
};
var motions = {
    moveToTopLine: function (cm, _head, motionArgs) {
        var line = getUserVisibleLines(cm).top + motionArgs.repeat - 1;
        return new Pos(line, findFirstNonWhiteSpaceCharacter(cm.getLine(line)));
    },
    moveToMiddleLine: function (cm) {
        var range = getUserVisibleLines(cm);
        var line = Math.floor((range.top + range.bottom) * 0.5);
        return new Pos(line, findFirstNonWhiteSpaceCharacter(cm.getLine(line)));
    },
    moveToBottomLine: function (cm, _head, motionArgs) {
        var line = getUserVisibleLines(cm).bottom - motionArgs.repeat + 1;
        return new Pos(line, findFirstNonWhiteSpaceCharacter(cm.getLine(line)));
    },
    expandToLine: function (_cm, head, motionArgs) {
        var cur = head;
        return new Pos(cur.line + motionArgs.repeat - 1, Infinity);
    },
    findNext: function (cm, _head, motionArgs) {
        var state = getSearchState(cm);
        var query = state.getQuery();
        if (!query) {
            return;
        }
        var prev = !motionArgs.forward;
        prev = (state.isReversed()) ? !prev : prev;
        highlightSearchMatches(cm, query);
        return findNext(cm, prev /** prev */, query, motionArgs.repeat);
    },
    findAndSelectNextInclusive: function (cm, _head, motionArgs, vim, prevInputState) {
        var state = getSearchState(cm);
        var query = state.getQuery();
        if (!query) {
            return;
        }
        var prev = !motionArgs.forward;
        prev = (state.isReversed()) ? !prev : prev;
        var next = findNextFromAndToInclusive(cm, prev, query, motionArgs.repeat, vim);
        if (!next) {
            return;
        }
        if (prevInputState.operator) {
            return next;
        }
        var from = next[0];
        var to = new Pos(next[1].line, next[1].ch - 1);
        if (vim.visualMode) {
            if (vim.visualLine || vim.visualBlock) {
                vim.visualLine = false;
                vim.visualBlock = false;
                CodeMirror.signal(cm, "vim-mode-change", { mode: "visual", subMode: "" });
            }
            var anchor = vim.sel.anchor;
            if (anchor) {
                if (state.isReversed()) {
                    if (motionArgs.forward) {
                        return [anchor, from];
                    }
                    return [anchor, to];
                }
                else {
                    if (motionArgs.forward) {
                        return [anchor, to];
                    }
                    return [anchor, from];
                }
            }
        }
        else {
            vim.visualMode = true;
            vim.visualLine = false;
            vim.visualBlock = false;
            CodeMirror.signal(cm, "vim-mode-change", { mode: "visual", subMode: "" });
        }
        return prev ? [to, from] : [from, to];
    },
    goToMark: function (cm, _head, motionArgs, vim) {
        var pos = getMarkPos(cm, vim, motionArgs.selectedCharacter);
        if (pos) {
            return motionArgs.linewise ? { line: pos.line, ch: findFirstNonWhiteSpaceCharacter(cm.getLine(pos.line)) } : pos;
        }
        return null;
    },
    moveToOtherHighlightedEnd: function (cm, _head, motionArgs, vim) {
        if (vim.visualBlock && motionArgs.sameLine) {
            var sel = vim.sel;
            return [
                clipCursorToContent(cm, new Pos(sel.anchor.line, sel.head.ch)),
                clipCursorToContent(cm, new Pos(sel.head.line, sel.anchor.ch))
            ];
        }
        else {
            return ([vim.sel.head, vim.sel.anchor]);
        }
    },
    jumpToMark: function (cm, head, motionArgs, vim) {
        var best = head;
        for (var i = 0; i < motionArgs.repeat; i++) {
            var cursor = best;
            for (var key in vim.marks) {
                if (!isLowerCase(key)) {
                    continue;
                }
                var mark = vim.marks[key].find();
                var isWrongDirection = (motionArgs.forward) ?
                    cursorIsBefore(mark, cursor) : cursorIsBefore(cursor, mark);
                if (isWrongDirection) {
                    continue;
                }
                if (motionArgs.linewise && (mark.line == cursor.line)) {
                    continue;
                }
                var equal = cursorEqual(cursor, best);
                var between = (motionArgs.forward) ?
                    cursorIsBetween(cursor, mark, best) :
                    cursorIsBetween(best, mark, cursor);
                if (equal || between) {
                    best = mark;
                }
            }
        }
        if (motionArgs.linewise) {
            best = new Pos(best.line, findFirstNonWhiteSpaceCharacter(cm.getLine(best.line)));
        }
        return best;
    },
    moveByCharacters: function (_cm, head, motionArgs) {
        var cur = head;
        var repeat = motionArgs.repeat;
        var ch = motionArgs.forward ? cur.ch + repeat : cur.ch - repeat;
        return new Pos(cur.line, ch);
    },
    moveByLines: function (cm, head, motionArgs, vim) {
        var cur = head;
        var endCh = cur.ch;
        switch (vim.lastMotion) {
            case this.moveByLines:
            case this.moveByDisplayLines:
            case this.moveByScroll:
            case this.moveToColumn:
            case this.moveToEol:
                endCh = vim.lastHPos;
                break;
            default:
                vim.lastHPos = endCh;
        }
        var repeat = motionArgs.repeat + (motionArgs.repeatOffset || 0);
        var line = motionArgs.forward ? cur.line + repeat : cur.line - repeat;
        var first = cm.firstLine();
        var last = cm.lastLine();
        if (line < first && cur.line == first) {
            return this.moveToStartOfLine(cm, head, motionArgs, vim);
        }
        else if (line > last && cur.line == last) {
            return moveToEol(cm, head, motionArgs, vim, true);
        }
        var fold = cm.ace.session.getFoldLine(line);
        if (fold) {
            if (motionArgs.forward) {
                if (line > fold.start.row)
                    line = fold.end.row + 1;
            }
            else {
                line = fold.start.row;
            }
        }
        if (motionArgs.toFirstChar) {
            endCh = findFirstNonWhiteSpaceCharacter(cm.getLine(line));
            vim.lastHPos = endCh;
        }
        vim.lastHSPos = cm.charCoords(new Pos(line, endCh), 'div').left;
        return new Pos(line, endCh);
    },
    moveByDisplayLines: function (cm, head, motionArgs, vim) {
        var cur = head;
        switch (vim.lastMotion) {
            case this.moveByDisplayLines:
            case this.moveByScroll:
            case this.moveByLines:
            case this.moveToColumn:
            case this.moveToEol:
                break;
            default:
                vim.lastHSPos = cm.charCoords(cur, 'div').left;
        }
        var repeat = motionArgs.repeat;
        var res = cm.findPosV(cur, (motionArgs.forward ? repeat : -repeat), 'line', vim.lastHSPos);
        if (res.hitSide) {
            if (motionArgs.forward) {
                var lastCharCoords = cm.charCoords(res, 'div');
                var goalCoords = { top: lastCharCoords.top + 8, left: vim.lastHSPos };
                var res = cm.coordsChar(goalCoords, 'div');
            }
            else {
                var resCoords = cm.charCoords(new Pos(cm.firstLine(), 0), 'div');
                resCoords.left = vim.lastHSPos;
                res = cm.coordsChar(resCoords, 'div');
            }
        }
        vim.lastHPos = res.ch;
        return res;
    },
    moveByPage: function (cm, head, motionArgs) {
        var curStart = head;
        var repeat = motionArgs.repeat;
        return cm.findPosV(curStart, (motionArgs.forward ? repeat : -repeat), 'page');
    },
    moveByParagraph: function (cm, head, motionArgs) {
        var dir = motionArgs.forward ? 1 : -1;
        return findParagraph(cm, head, motionArgs.repeat, dir);
    },
    moveBySentence: function (cm, head, motionArgs) {
        var dir = motionArgs.forward ? 1 : -1;
        return findSentence(cm, head, motionArgs.repeat, dir);
    },
    moveByScroll: function (cm, head, motionArgs, vim) {
        var scrollbox = cm.getScrollInfo();
        var curEnd = null;
        var repeat = motionArgs.repeat;
        if (!repeat) {
            repeat = scrollbox.clientHeight / (2 * cm.defaultTextHeight());
        }
        var orig = cm.charCoords(head, 'local');
        motionArgs.repeat = repeat;
        curEnd = motions.moveByDisplayLines(cm, head, motionArgs, vim);
        if (!curEnd) {
            return null;
        }
        var dest = cm.charCoords(curEnd, 'local');
        cm.scrollTo(null, scrollbox.top + dest.top - orig.top);
        return curEnd;
    },
    moveByWords: function (cm, head, motionArgs) {
        return moveToWord(cm, head, motionArgs.repeat, !!motionArgs.forward, !!motionArgs.wordEnd, !!motionArgs.bigWord);
    },
    moveTillCharacter: function (cm, head, motionArgs) {
        var repeat = motionArgs.repeat;
        var curEnd = moveToCharacter(cm, repeat, motionArgs.forward, motionArgs.selectedCharacter, head);
        var increment = motionArgs.forward ? -1 : 1;
        recordLastCharacterSearch(increment, motionArgs);
        if (!curEnd)
            return null;
        curEnd.ch += increment;
        return curEnd;
    },
    moveToCharacter: function (cm, head, motionArgs) {
        var repeat = motionArgs.repeat;
        recordLastCharacterSearch(0, motionArgs);
        return moveToCharacter(cm, repeat, motionArgs.forward, motionArgs.selectedCharacter, head) || head;
    },
    moveToSymbol: function (cm, head, motionArgs) {
        var repeat = motionArgs.repeat;
        return findSymbol(cm, repeat, motionArgs.forward, motionArgs.selectedCharacter) || head;
    },
    moveToColumn: function (cm, head, motionArgs, vim) {
        var repeat = motionArgs.repeat;
        vim.lastHPos = repeat - 1;
        vim.lastHSPos = cm.charCoords(head, 'div').left;
        return moveToColumn(cm, repeat);
    },
    moveToEol: function (cm, head, motionArgs, vim) {
        return moveToEol(cm, head, motionArgs, vim, false);
    },
    moveToFirstNonWhiteSpaceCharacter: function (cm, head) {
        var cursor = head;
        return new Pos(cursor.line, findFirstNonWhiteSpaceCharacter(cm.getLine(cursor.line)));
    },
    moveToMatchedSymbol: function (cm, head) {
        var cursor = head;
        var line = cursor.line;
        var ch = cursor.ch;
        var lineText = cm.getLine(line);
        var symbol;
        for (; ch < lineText.length; ch++) {
            symbol = lineText.charAt(ch);
            if (symbol && isMatchableSymbol(symbol)) {
                var style = cm.getTokenTypeAt(new Pos(line, ch + 1));
                if (style !== "string" && style !== "comment") {
                    break;
                }
            }
        }
        if (ch < lineText.length) {
            var re = /[<>]/.test(lineText[ch]) ? /[(){}[\]<>]/ : /[(){}[\]]/; //ace_patch?
            var matched = cm.findMatchingBracket(new Pos(line, ch + 1), { bracketRegex: re });
            return matched.to;
        }
        else {
            return cursor;
        }
    },
    moveToStartOfLine: function (_cm, head) {
        return new Pos(head.line, 0);
    },
    moveToLineOrEdgeOfDocument: function (cm, _head, motionArgs) {
        var lineNum = motionArgs.forward ? cm.lastLine() : cm.firstLine();
        if (motionArgs.repeatIsExplicit) {
            lineNum = motionArgs.repeat - cm.getOption('firstLineNumber');
        }
        return new Pos(lineNum, findFirstNonWhiteSpaceCharacter(cm.getLine(lineNum)));
    },
    moveToStartOfDisplayLine: function (cm) {
        cm.execCommand("goLineLeft");
        return cm.getCursor();
    },
    moveToEndOfDisplayLine: function (cm) {
        cm.execCommand("goLineRight");
        var head = cm.getCursor();
        if (head.sticky == "before")
            head.ch--;
        return head;
    },
    textObjectManipulation: function (cm, head, motionArgs, vim) {
        var mirroredPairs = { '(': ')', ')': '(',
            '{': '}', '}': '{',
            '[': ']', ']': '[',
            '<': '>', '>': '<' };
        var selfPaired = { '\'': true, '"': true, '`': true };
        var character = motionArgs.selectedCharacter;
        if (character == 'b') {
            character = '(';
        }
        else if (character == 'B') {
            character = '{';
        }
        var inclusive = !motionArgs.textObjectInner;
        var tmp, move;
        if (mirroredPairs[character]) {
            move = true;
            tmp = selectCompanionObject(cm, head, character, inclusive);
            if (!tmp) {
                var sc = cm.getSearchCursor(new RegExp("\\" + character, "g"), head);
                if (sc.find()) {
                    tmp = selectCompanionObject(cm, sc.from(), character, inclusive);
                }
            }
        }
        else if (selfPaired[character]) {
            move = true;
            tmp = findBeginningAndEnd(cm, head, character, inclusive);
        }
        else if (character === 'W' || character === 'w') {
            var repeat = motionArgs.repeat || 1;
            while (repeat-- > 0) {
                var repeated = expandWordUnderCursor(cm, {
                    inclusive: inclusive,
                    innerWord: !inclusive,
                    bigWord: character === 'W',
                    noSymbol: character === 'W',
                    multiline: true
                }, tmp && tmp.end);
                if (repeated) {
                    if (!tmp)
                        tmp = repeated;
                    tmp.end = repeated.end;
                }
            }
        }
        else if (character === 'p') {
            tmp = findParagraph(cm, head, motionArgs.repeat, 0, inclusive);
            motionArgs.linewise = true;
            if (vim.visualMode) {
                if (!vim.visualLine) {
                    vim.visualLine = true;
                }
            }
            else {
                var operatorArgs = vim.inputState.operatorArgs;
                if (operatorArgs) {
                    operatorArgs.linewise = true;
                }
                tmp.end.line--;
            }
        }
        else if (character === 't') {
            tmp = expandTagUnderCursor(cm, head, inclusive);
        }
        else if (character === 's') {
            var content = cm.getLine(head.line);
            if (head.ch > 0 && isEndOfSentenceSymbol(content[head.ch])) {
                head.ch -= 1;
            }
            var end = getSentence(cm, head, motionArgs.repeat, 1, inclusive);
            var start = getSentence(cm, head, motionArgs.repeat, -1, inclusive);
            if (isWhiteSpaceString(cm.getLine(start.line)[start.ch])
                && isWhiteSpaceString(cm.getLine(end.line)[end.ch - 1])) {
                start = { line: start.line, ch: start.ch + 1 };
            }
            tmp = { start: start, end: end };
        }
        if (!tmp) {
            return null;
        }
        if (!cm.state.vim.visualMode) {
            return [tmp.start, tmp.end];
        }
        else {
            return expandSelection(cm, tmp.start, tmp.end, move);
        }
    },
    repeatLastCharacterSearch: function (cm, head, motionArgs) {
        var lastSearch = vimGlobalState.lastCharacterSearch;
        var repeat = motionArgs.repeat;
        var forward = motionArgs.forward === lastSearch.forward;
        var increment = (lastSearch.increment ? 1 : 0) * (forward ? -1 : 1);
        cm.moveH(-increment, 'char');
        motionArgs.inclusive = forward ? true : false;
        var curEnd = moveToCharacter(cm, repeat, forward, lastSearch.selectedCharacter);
        if (!curEnd) {
            cm.moveH(increment, 'char');
            return head;
        }
        curEnd.ch += increment;
        return curEnd;
    }
};
function defineMotion(name, fn) {
    motions[name] = fn;
}
function fillArray(val, times) {
    var arr = [];
    for (var i = 0; i < times; i++) {
        arr.push(val);
    }
    return arr;
}
var operators = {
    change: function (cm, args, ranges) {
        var finalHead, text;
        var vim = cm.state.vim;
        var anchor = ranges[0].anchor, head = ranges[0].head;
        if (!vim.visualMode) {
            text = cm.getRange(anchor, head);
            var lastState = vim.lastEditInputState || {};
            if (lastState.motion == "moveByWords" && !isWhiteSpaceString(text)) {
                var match = (/\s+$/).exec(text);
                if (match && lastState.motionArgs && lastState.motionArgs.forward) {
                    head = offsetCursor(head, 0, -match[0].length);
                    text = text.slice(0, -match[0].length);
                }
            }
            if (args.linewise) {
                anchor = new Pos(anchor.line, findFirstNonWhiteSpaceCharacter(cm.getLine(anchor.line)));
                if (head.line > anchor.line) {
                    head = new Pos(head.line - 1, Number.MAX_VALUE);
                }
            }
            cm.replaceRange('', anchor, head);
            finalHead = anchor;
        }
        else if (args.fullLine) {
            head.ch = Number.MAX_VALUE;
            head.line--;
            cm.setSelection(anchor, head);
            text = cm.getSelection();
            cm.replaceSelection("");
            finalHead = anchor;
        }
        else {
            text = cm.getSelection();
            var replacement = fillArray('', ranges.length);
            cm.replaceSelections(replacement);
            finalHead = cursorMin(ranges[0].head, ranges[0].anchor);
        }
        vimGlobalState.registerController.pushText(args.registerName, 'change', text, args.linewise, ranges.length > 1);
        actions.enterInsertMode(cm, { head: finalHead }, cm.state.vim);
    },
    'delete': function (cm, args, ranges) {
        var finalHead, text;
        var vim = cm.state.vim;
        if (!vim.visualBlock) {
            var anchor = ranges[0].anchor, head = ranges[0].head;
            if (args.linewise &&
                head.line != cm.firstLine() &&
                anchor.line == cm.lastLine() &&
                anchor.line == head.line - 1) {
                if (anchor.line == cm.firstLine()) {
                    anchor.ch = 0;
                }
                else {
                    anchor = new Pos(anchor.line - 1, lineLength(cm, anchor.line - 1));
                }
            }
            text = cm.getRange(anchor, head);
            cm.replaceRange('', anchor, head);
            finalHead = anchor;
            if (args.linewise) {
                finalHead = motions.moveToFirstNonWhiteSpaceCharacter(cm, anchor);
            }
        }
        else {
            text = cm.getSelection();
            var replacement = fillArray('', ranges.length);
            cm.replaceSelections(replacement);
            finalHead = cursorMin(ranges[0].head, ranges[0].anchor);
        }
        vimGlobalState.registerController.pushText(args.registerName, 'delete', text, args.linewise, vim.visualBlock);
        return clipCursorToContent(cm, finalHead);
    },
    indent: function (cm, args, ranges) {
        var vim = cm.state.vim;
        var repeat = (vim.visualMode) ? args.repeat : 1;
        if (vim.visualBlock) {
            var tabSize = cm.getOption('tabSize');
            var indent = cm.getOption('indentWithTabs') ? '\t' : ' '.repeat(tabSize);
            var cursor;
            for (var i = ranges.length - 1; i >= 0; i--) {
                cursor = cursorMin(ranges[i].anchor, ranges[i].head);
                if (args.indentRight) {
                    cm.replaceRange(indent.repeat(repeat), cursor, cursor);
                }
                else {
                    var text = cm.getLine(cursor.line);
                    var end = 0;
                    for (var j = 0; j < repeat; j++) {
                        var ch = text[cursor.ch + end];
                        if (ch == '\t') {
                            end++;
                        }
                        else if (ch == ' ') {
                            end++;
                            for (var k = 1; k < indent.length; k++) {
                                ch = text[cursor.ch + end];
                                if (ch !== ' ')
                                    break;
                                end++;
                            }
                        }
                        else {
                            break;
                        }
                    }
                    cm.replaceRange('', cursor, offsetCursor(cursor, 0, end));
                }
            }
            return cursor;
        }
        else if (cm.indentMore) {
            for (var j = 0; j < repeat; j++) {
                if (args.indentRight)
                    cm.indentMore();
                else
                    cm.indentLess();
            }
        }
        else {
            var startLine = ranges[0].anchor.line;
            var endLine = vim.visualBlock ?
                ranges[ranges.length - 1].anchor.line :
                ranges[0].head.line;
            if (args.linewise) {
                endLine--;
            }
            for (var i = startLine; i <= endLine; i++) {
                for (var j = 0; j < repeat; j++) {
                    cm.indentLine(i, args.indentRight);
                }
            }
        }
        return motions.moveToFirstNonWhiteSpaceCharacter(cm, ranges[0].anchor);
    },
    indentAuto: function (cm, _args, ranges) {
        cm.execCommand("indentAuto");
        return motions.moveToFirstNonWhiteSpaceCharacter(cm, ranges[0].anchor);
    },
    hardWrap: function (cm, operatorArgs, ranges, oldAnchor, newHead) {
        if (!cm.hardWrap)
            return;
        var from = ranges[0].anchor.line;
        var to = ranges[0].head.line;
        if (operatorArgs.linewise)
            to--;
        var endRow = cm.hardWrap({ from: from, to: to });
        if (endRow > from && operatorArgs.linewise)
            endRow--;
        return operatorArgs.keepCursor ? oldAnchor : new Pos(endRow, 0);
    },
    changeCase: function (cm, args, ranges, oldAnchor, newHead) {
        var selections = cm.getSelections();
        var swapped = [];
        var toLower = args.toLower;
        for (var j = 0; j < selections.length; j++) {
            var toSwap = selections[j];
            var text = '';
            if (toLower === true) {
                text = toSwap.toLowerCase();
            }
            else if (toLower === false) {
                text = toSwap.toUpperCase();
            }
            else {
                for (var i = 0; i < toSwap.length; i++) {
                    var character = toSwap.charAt(i);
                    text += isUpperCase(character) ? character.toLowerCase() :
                        character.toUpperCase();
                }
            }
            swapped.push(text);
        }
        cm.replaceSelections(swapped);
        if (args.shouldMoveCursor) {
            return newHead;
        }
        else if (!cm.state.vim.visualMode && args.linewise && ranges[0].anchor.line + 1 == ranges[0].head.line) {
            return motions.moveToFirstNonWhiteSpaceCharacter(cm, oldAnchor);
        }
        else if (args.linewise) {
            return oldAnchor;
        }
        else {
            return cursorMin(ranges[0].anchor, ranges[0].head);
        }
    },
    yank: function (cm, args, ranges, oldAnchor) {
        var vim = cm.state.vim;
        var text = cm.getSelection();
        var endPos = vim.visualMode
            ? cursorMin(vim.sel.anchor, vim.sel.head, ranges[0].head, ranges[0].anchor)
            : oldAnchor;
        vimGlobalState.registerController.pushText(args.registerName, 'yank', text, args.linewise, vim.visualBlock);
        return endPos;
    }
};
function defineOperator(name, fn) {
    operators[name] = fn;
}
var actions = {
    jumpListWalk: function (cm, actionArgs, vim) {
        if (vim.visualMode) {
            return;
        }
        var repeat = actionArgs.repeat;
        var forward = actionArgs.forward;
        var jumpList = vimGlobalState.jumpList;
        var mark = jumpList.move(cm, forward ? repeat : -repeat);
        var markPos = mark ? mark.find() : undefined;
        markPos = markPos ? markPos : cm.getCursor();
        cm.setCursor(markPos);
        cm.ace.curOp.command.scrollIntoView = "center-animate"; // ace_patch
    },
    scroll: function (cm, actionArgs, vim) {
        if (vim.visualMode) {
            return;
        }
        var repeat = actionArgs.repeat || 1;
        var lineHeight = cm.defaultTextHeight();
        var top = cm.getScrollInfo().top;
        var delta = lineHeight * repeat;
        var newPos = actionArgs.forward ? top + delta : top - delta;
        var cursor = copyCursor(cm.getCursor());
        var cursorCoords = cm.charCoords(cursor, 'local');
        if (actionArgs.forward) {
            if (newPos > cursorCoords.top) {
                cursor.line += (newPos - cursorCoords.top) / lineHeight;
                cursor.line = Math.ceil(cursor.line);
                cm.setCursor(cursor);
                cursorCoords = cm.charCoords(cursor, 'local');
                cm.scrollTo(null, cursorCoords.top);
            }
            else {
                cm.scrollTo(null, newPos);
            }
        }
        else {
            var newBottom = newPos + cm.getScrollInfo().clientHeight;
            if (newBottom < cursorCoords.bottom) {
                cursor.line -= (cursorCoords.bottom - newBottom) / lineHeight;
                cursor.line = Math.floor(cursor.line);
                cm.setCursor(cursor);
                cursorCoords = cm.charCoords(cursor, 'local');
                cm.scrollTo(null, cursorCoords.bottom - cm.getScrollInfo().clientHeight);
            }
            else {
                cm.scrollTo(null, newPos);
            }
        }
    },
    scrollToCursor: function (cm, actionArgs) {
        var lineNum = cm.getCursor().line;
        var charCoords = cm.charCoords(new Pos(lineNum, 0), 'local');
        var height = cm.getScrollInfo().clientHeight;
        var y = charCoords.top;
        switch (actionArgs.position) {
            case 'center':
                y = charCoords.bottom - height / 2;
                break;
            case 'bottom':
                var lineLastCharPos = new Pos(lineNum, cm.getLine(lineNum).length - 1);
                var lineLastCharCoords = cm.charCoords(lineLastCharPos, 'local');
                var lineHeight = lineLastCharCoords.bottom - y;
                y = y - height + lineHeight;
                break;
        }
        cm.scrollTo(null, y);
    },
    replayMacro: function (cm, actionArgs, vim) {
        var registerName = actionArgs.selectedCharacter;
        var repeat = actionArgs.repeat;
        var macroModeState = vimGlobalState.macroModeState;
        if (registerName == '@') {
            registerName = macroModeState.latestRegister;
        }
        else {
            macroModeState.latestRegister = registerName;
        }
        while (repeat--) {
            executeMacroRegister(cm, vim, macroModeState, registerName);
        }
    },
    enterMacroRecordMode: function (cm, actionArgs) {
        var macroModeState = vimGlobalState.macroModeState;
        var registerName = actionArgs.selectedCharacter;
        if (vimGlobalState.registerController.isValidRegister(registerName)) {
            macroModeState.enterMacroRecordMode(cm, registerName);
        }
    },
    toggleOverwrite: function (cm) {
        if (!cm.state.overwrite) {
            cm.toggleOverwrite(true);
            cm.setOption('keyMap', 'vim-replace');
            CodeMirror.signal(cm, "vim-mode-change", { mode: "replace" });
        }
        else {
            cm.toggleOverwrite(false);
            cm.setOption('keyMap', 'vim-insert');
            CodeMirror.signal(cm, "vim-mode-change", { mode: "insert" });
        }
    },
    enterInsertMode: function (cm, actionArgs, vim) {
        if (cm.getOption('readOnly')) {
            return;
        }
        vim.insertMode = true;
        vim.insertModeRepeat = actionArgs && actionArgs.repeat || 1;
        var insertAt = (actionArgs) ? actionArgs.insertAt : null;
        var sel = vim.sel;
        var head = actionArgs.head || cm.getCursor('head');
        var height = cm.listSelections().length;
        if (insertAt == 'eol') {
            head = new Pos(head.line, lineLength(cm, head.line));
        }
        else if (insertAt == 'bol') {
            head = new Pos(head.line, 0);
        }
        else if (insertAt == 'charAfter') {
            var newPosition = updateSelectionForSurrogateCharacters(cm, head, offsetCursor(head, 0, 1));
            head = newPosition.end;
        }
        else if (insertAt == 'firstNonBlank') {
            var newPosition = updateSelectionForSurrogateCharacters(cm, head, motions.moveToFirstNonWhiteSpaceCharacter(cm, head));
            head = newPosition.end;
        }
        else if (insertAt == 'startOfSelectedArea') {
            if (!vim.visualMode)
                return;
            if (!vim.visualBlock) {
                if (sel.head.line < sel.anchor.line) {
                    head = sel.head;
                }
                else {
                    head = new Pos(sel.anchor.line, 0);
                }
            }
            else {
                head = new Pos(Math.min(sel.head.line, sel.anchor.line), Math.min(sel.head.ch, sel.anchor.ch));
                height = Math.abs(sel.head.line - sel.anchor.line) + 1;
            }
        }
        else if (insertAt == 'endOfSelectedArea') {
            if (!vim.visualMode)
                return;
            if (!vim.visualBlock) {
                if (sel.head.line >= sel.anchor.line) {
                    head = offsetCursor(sel.head, 0, 1);
                }
                else {
                    head = new Pos(sel.anchor.line, 0);
                }
            }
            else {
                head = new Pos(Math.min(sel.head.line, sel.anchor.line), Math.max(sel.head.ch, sel.anchor.ch) + 1);
                height = Math.abs(sel.head.line - sel.anchor.line) + 1;
            }
        }
        else if (insertAt == 'inplace') {
            if (vim.visualMode) {
                return;
            }
        }
        else if (insertAt == 'lastEdit') {
            head = getLastEditPos(cm) || head;
        }
        cm.setOption('disableInput', false);
        if (actionArgs && actionArgs.replace) {
            cm.toggleOverwrite(true);
            cm.setOption('keyMap', 'vim-replace');
            CodeMirror.signal(cm, "vim-mode-change", { mode: "replace" });
        }
        else {
            cm.toggleOverwrite(false);
            cm.setOption('keyMap', 'vim-insert');
            CodeMirror.signal(cm, "vim-mode-change", { mode: "insert" });
        }
        if (!vimGlobalState.macroModeState.isPlaying) {
            cm.on('change', onChange);
            if (vim.insertEnd)
                vim.insertEnd.clear();
            vim.insertEnd = cm.setBookmark(head, { insertLeft: true });
            CodeMirror.on(cm.getInputField(), 'keydown', onKeyEventTargetKeyDown);
        }
        if (vim.visualMode) {
            exitVisualMode(cm);
        }
        selectForInsert(cm, head, height);
    },
    toggleVisualMode: function (cm, actionArgs, vim) {
        var repeat = actionArgs.repeat;
        var anchor = cm.getCursor();
        var head;
        if (!vim.visualMode) {
            vim.visualMode = true;
            vim.visualLine = !!actionArgs.linewise;
            vim.visualBlock = !!actionArgs.blockwise;
            head = clipCursorToContent(cm, new Pos(anchor.line, anchor.ch + repeat - 1));
            var newPosition = updateSelectionForSurrogateCharacters(cm, anchor, head);
            vim.sel = {
                anchor: newPosition.start,
                head: newPosition.end
            };
            CodeMirror.signal(cm, "vim-mode-change", { mode: "visual", subMode: vim.visualLine ? "linewise" : vim.visualBlock ? "blockwise" : "" });
            updateCmSelection(cm);
            updateMark(cm, vim, '<', cursorMin(anchor, head));
            updateMark(cm, vim, '>', cursorMax(anchor, head));
        }
        else if (vim.visualLine ^ actionArgs.linewise ||
            vim.visualBlock ^ actionArgs.blockwise) {
            vim.visualLine = !!actionArgs.linewise;
            vim.visualBlock = !!actionArgs.blockwise;
            CodeMirror.signal(cm, "vim-mode-change", { mode: "visual", subMode: vim.visualLine ? "linewise" : vim.visualBlock ? "blockwise" : "" });
            updateCmSelection(cm);
        }
        else {
            exitVisualMode(cm);
        }
    },
    reselectLastSelection: function (cm, _actionArgs, vim) {
        var lastSelection = vim.lastSelection;
        if (vim.visualMode) {
            updateLastSelection(cm, vim);
        }
        if (lastSelection) {
            var anchor = lastSelection.anchorMark.find();
            var head = lastSelection.headMark.find();
            if (!anchor || !head) {
                return;
            }
            vim.sel = {
                anchor: anchor,
                head: head
            };
            vim.visualMode = true;
            vim.visualLine = lastSelection.visualLine;
            vim.visualBlock = lastSelection.visualBlock;
            updateCmSelection(cm);
            updateMark(cm, vim, '<', cursorMin(anchor, head));
            updateMark(cm, vim, '>', cursorMax(anchor, head));
            CodeMirror.signal(cm, 'vim-mode-change', {
                mode: 'visual',
                subMode: vim.visualLine ? 'linewise' :
                    vim.visualBlock ? 'blockwise' : ''
            });
        }
    },
    joinLines: function (cm, actionArgs, vim) {
        var curStart, curEnd;
        if (vim.visualMode) {
            curStart = cm.getCursor('anchor');
            curEnd = cm.getCursor('head');
            if (cursorIsBefore(curEnd, curStart)) {
                var tmp = curEnd;
                curEnd = curStart;
                curStart = tmp;
            }
            curEnd.ch = lineLength(cm, curEnd.line) - 1;
        }
        else {
            var repeat = Math.max(actionArgs.repeat, 2);
            curStart = cm.getCursor();
            curEnd = clipCursorToContent(cm, new Pos(curStart.line + repeat - 1, Infinity));
        }
        var finalCh = 0;
        for (var i = curStart.line; i < curEnd.line; i++) {
            finalCh = lineLength(cm, curStart.line);
            var text = '';
            var nextStartCh = 0;
            if (!actionArgs.keepSpaces) {
                var nextLine = cm.getLine(curStart.line + 1);
                nextStartCh = nextLine.search(/\S/);
                if (nextStartCh == -1) {
                    nextStartCh = nextLine.length;
                }
                else {
                    text = " ";
                }
            }
            cm.replaceRange(text, new Pos(curStart.line, finalCh), new Pos(curStart.line + 1, nextStartCh));
        }
        var curFinalPos = clipCursorToContent(cm, new Pos(curStart.line, finalCh));
        if (vim.visualMode) {
            exitVisualMode(cm, false);
        }
        cm.setCursor(curFinalPos);
    },
    newLineAndEnterInsertMode: function (cm, actionArgs, vim) {
        vim.insertMode = true;
        var insertAt = copyCursor(cm.getCursor());
        if (insertAt.line === cm.firstLine() && !actionArgs.after) {
            cm.replaceRange('\n', new Pos(cm.firstLine(), 0));
            cm.setCursor(cm.firstLine(), 0);
        }
        else {
            insertAt.line = (actionArgs.after) ? insertAt.line :
                insertAt.line - 1;
            insertAt.ch = lineLength(cm, insertAt.line);
            cm.setCursor(insertAt);
            var newlineFn = CodeMirror.commands.newlineAndIndentContinueComment ||
                CodeMirror.commands.newlineAndIndent;
            newlineFn(cm);
        }
        this.enterInsertMode(cm, { repeat: actionArgs.repeat }, vim);
    },
    paste: function (cm, actionArgs, vim) {
        var _this = this;
        var register = vimGlobalState.registerController.getRegister(actionArgs.registerName);
        var fallback = function () {
            var text = register.toString();
            _this.continuePaste(cm, actionArgs, vim, text, register);
        };
        if (actionArgs.registerName === '+' &&
            typeof navigator !== 'undefined' &&
            typeof navigator.clipboard !== 'undefined' &&
            typeof navigator.clipboard.readText === 'function') {
            navigator.clipboard.readText().then(function (value) {
                _this.continuePaste(cm, actionArgs, vim, value, register);
            }, function () { fallback(); });
        }
        else {
            fallback();
        }
    },
    continuePaste: function (cm, actionArgs, vim, text, register) {
        var cur = copyCursor(cm.getCursor());
        if (!text) {
            return;
        }
        if (actionArgs.matchIndent) {
            var tabSize = cm.getOption("tabSize");
            var whitespaceLength = function (str) {
                var tabs = (str.split("\t").length - 1);
                var spaces = (str.split(" ").length - 1);
                return tabs * tabSize + spaces * 1;
            };
            var currentLine = cm.getLine(cm.getCursor().line);
            var indent = whitespaceLength(currentLine.match(/^\s*/)[0]);
            var chompedText = text.replace(/\n$/, '');
            var wasChomped = text !== chompedText;
            var firstIndent = whitespaceLength(text.match(/^\s*/)[0]);
            var text = chompedText.replace(/^\s*/gm, function (wspace) {
                var newIndent = indent + (whitespaceLength(wspace) - firstIndent);
                if (newIndent < 0) {
                    return "";
                }
                else if (cm.getOption("indentWithTabs")) {
                    var quotient = Math.floor(newIndent / tabSize);
                    return Array(quotient + 1).join('\t');
                }
                else {
                    return Array(newIndent + 1).join(' ');
                }
            });
            text += wasChomped ? "\n" : "";
        }
        if (actionArgs.repeat > 1) {
            var text = Array(actionArgs.repeat + 1).join(text);
        }
        var linewise = register.linewise;
        var blockwise = register.blockwise;
        if (blockwise) {
            text = text.split('\n');
            if (linewise) {
                text.pop();
            }
            for (var i = 0; i < text.length; i++) {
                text[i] = (text[i] == '') ? ' ' : text[i];
            }
            cur.ch += actionArgs.after ? 1 : 0;
            cur.ch = Math.min(lineLength(cm, cur.line), cur.ch);
        }
        else if (linewise) {
            if (vim.visualMode) {
                text = vim.visualLine ? text.slice(0, -1) : '\n' + text.slice(0, text.length - 1) + '\n';
            }
            else if (actionArgs.after) {
                text = '\n' + text.slice(0, text.length - 1);
                cur.ch = lineLength(cm, cur.line);
            }
            else {
                cur.ch = 0;
            }
        }
        else {
            cur.ch += actionArgs.after ? 1 : 0;
        }
        var curPosFinal;
        if (vim.visualMode) {
            vim.lastPastedText = text;
            var lastSelectionCurEnd;
            var selectedArea = getSelectedAreaRange(cm, vim);
            var selectionStart = selectedArea[0];
            var selectionEnd = selectedArea[1];
            var selectedText = cm.getSelection();
            var selections = cm.listSelections();
            var emptyStrings = new Array(selections.length).join('1').split('1');
            if (vim.lastSelection) {
                lastSelectionCurEnd = vim.lastSelection.headMark.find();
            }
            vimGlobalState.registerController.unnamedRegister.setText(selectedText);
            if (blockwise) {
                cm.replaceSelections(emptyStrings);
                selectionEnd = new Pos(selectionStart.line + text.length - 1, selectionStart.ch);
                cm.setCursor(selectionStart);
                selectBlock(cm, selectionEnd);
                cm.replaceSelections(text);
                curPosFinal = selectionStart;
            }
            else if (vim.visualBlock) {
                cm.replaceSelections(emptyStrings);
                cm.setCursor(selectionStart);
                cm.replaceRange(text, selectionStart, selectionStart);
                curPosFinal = selectionStart;
            }
            else {
                cm.replaceRange(text, selectionStart, selectionEnd);
                curPosFinal = cm.posFromIndex(cm.indexFromPos(selectionStart) + text.length - 1);
            }
            if (lastSelectionCurEnd) {
                vim.lastSelection.headMark = cm.setBookmark(lastSelectionCurEnd);
            }
            if (linewise) {
                curPosFinal.ch = 0;
            }
        }
        else {
            if (blockwise) {
                cm.setCursor(cur);
                for (var i = 0; i < text.length; i++) {
                    var line = cur.line + i;
                    if (line > cm.lastLine()) {
                        cm.replaceRange('\n', new Pos(line, 0));
                    }
                    var lastCh = lineLength(cm, line);
                    if (lastCh < cur.ch) {
                        extendLineToColumn(cm, line, cur.ch);
                    }
                }
                cm.setCursor(cur);
                selectBlock(cm, new Pos(cur.line + text.length - 1, cur.ch));
                cm.replaceSelections(text);
                curPosFinal = cur;
            }
            else {
                cm.replaceRange(text, cur);
                if (linewise) {
                    var line = actionArgs.after ? cur.line + 1 : cur.line;
                    curPosFinal = new Pos(line, findFirstNonWhiteSpaceCharacter(cm.getLine(line)));
                }
                else {
                    curPosFinal = copyCursor(cur);
                    if (!/\n/.test(text)) {
                        curPosFinal.ch += text.length - (actionArgs.after ? 1 : 0);
                    }
                }
            }
        }
        if (vim.visualMode) {
            exitVisualMode(cm, false);
        }
        cm.setCursor(curPosFinal);
    },
    undo: function (cm, actionArgs) {
        cm.operation(function () {
            repeatFn(cm, CodeMirror.commands.undo, actionArgs.repeat)();
            cm.setCursor(clipCursorToContent(cm, cm.getCursor('start')));
        });
    },
    redo: function (cm, actionArgs) {
        repeatFn(cm, CodeMirror.commands.redo, actionArgs.repeat)();
    },
    setRegister: function (_cm, actionArgs, vim) {
        vim.inputState.registerName = actionArgs.selectedCharacter;
    },
    insertRegister: function (cm, actionArgs, vim) {
        var registerName = actionArgs.selectedCharacter;
        var register = vimGlobalState.registerController.getRegister(registerName);
        var text = register && register.toString();
        if (text) {
            cm.replaceSelection(text);
        }
    },
    oneNormalCommand: function (cm, actionArgs, vim) {
        exitInsertMode(cm, true);
        vim.insertModeReturn = true;
        CodeMirror.on(cm, 'vim-command-done', function handler() {
            if (vim.visualMode)
                return;
            if (vim.insertModeReturn) {
                vim.insertModeReturn = false;
                if (!vim.insertMode) {
                    actions.enterInsertMode(cm, {}, vim);
                }
            }
            CodeMirror.off(cm, 'vim-command-done', handler);
        });
    },
    setMark: function (cm, actionArgs, vim) {
        var markName = actionArgs.selectedCharacter;
        updateMark(cm, vim, markName, cm.getCursor());
    },
    replace: function (cm, actionArgs, vim) {
        var replaceWith = actionArgs.selectedCharacter;
        var curStart = cm.getCursor();
        var replaceTo;
        var curEnd;
        var selections = cm.listSelections();
        if (vim.visualMode) {
            curStart = cm.getCursor('start');
            curEnd = cm.getCursor('end');
        }
        else {
            var line = cm.getLine(curStart.line);
            replaceTo = curStart.ch + actionArgs.repeat;
            if (replaceTo > line.length) {
                replaceTo = line.length;
            }
            curEnd = new Pos(curStart.line, replaceTo);
        }
        var newPositions = updateSelectionForSurrogateCharacters(cm, curStart, curEnd);
        curStart = newPositions.start;
        curEnd = newPositions.end;
        if (replaceWith == '\n') {
            if (!vim.visualMode)
                cm.replaceRange('', curStart, curEnd);
            (CodeMirror.commands.newlineAndIndentContinueComment || CodeMirror.commands.newlineAndIndent)(cm);
        }
        else {
            var replaceWithStr = cm.getRange(curStart, curEnd);
            replaceWithStr = replaceWithStr.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, replaceWith);
            replaceWithStr = replaceWithStr.replace(/[^\n]/g, replaceWith);
            if (vim.visualBlock) {
                var spaces = new Array(cm.getOption("tabSize") + 1).join(' ');
                replaceWithStr = cm.getSelection();
                replaceWithStr = replaceWithStr.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, replaceWith);
                replaceWithStr = replaceWithStr.replace(/\t/g, spaces).replace(/[^\n]/g, replaceWith).split('\n');
                cm.replaceSelections(replaceWithStr);
            }
            else {
                cm.replaceRange(replaceWithStr, curStart, curEnd);
            }
            if (vim.visualMode) {
                curStart = cursorIsBefore(selections[0].anchor, selections[0].head) ?
                    selections[0].anchor : selections[0].head;
                cm.setCursor(curStart);
                exitVisualMode(cm, false);
            }
            else {
                cm.setCursor(offsetCursor(curEnd, 0, -1));
            }
        }
    },
    incrementNumberToken: function (cm, actionArgs) {
        var cur = cm.getCursor();
        var lineStr = cm.getLine(cur.line);
        var re = /(-?)(?:(0x)([\da-f]+)|(0b|0|)(\d+))/gi;
        var match;
        var start;
        var end;
        var numberStr;
        while ((match = re.exec(lineStr)) !== null) {
            start = match.index;
            end = start + match[0].length;
            if (cur.ch < end)
                break;
        }
        if (!actionArgs.backtrack && (end <= cur.ch))
            return;
        if (match) {
            var baseStr = match[2] || match[4];
            var digits = match[3] || match[5];
            var increment = actionArgs.increase ? 1 : -1;
            var base = { '0b': 2, '0': 8, '': 10, '0x': 16 }[baseStr.toLowerCase()];
            var number = parseInt(match[1] + digits, base) + (increment * actionArgs.repeat);
            numberStr = number.toString(base);
            var zeroPadding = baseStr ? new Array(digits.length - numberStr.length + 1 + match[1].length).join('0') : '';
            if (numberStr.charAt(0) === '-') {
                numberStr = '-' + baseStr + zeroPadding + numberStr.substr(1);
            }
            else {
                numberStr = baseStr + zeroPadding + numberStr;
            }
            var from = new Pos(cur.line, start);
            var to = new Pos(cur.line, end);
            cm.replaceRange(numberStr, from, to);
        }
        else {
            return;
        }
        cm.setCursor(new Pos(cur.line, start + numberStr.length - 1));
    },
    repeatLastEdit: function (cm, actionArgs, vim) {
        var lastEditInputState = vim.lastEditInputState;
        if (!lastEditInputState) {
            return;
        }
        var repeat = actionArgs.repeat;
        if (repeat && actionArgs.repeatIsExplicit) {
            vim.lastEditInputState.repeatOverride = repeat;
        }
        else {
            repeat = vim.lastEditInputState.repeatOverride || repeat;
        }
        repeatLastEdit(cm, vim, repeat, false /** repeatForInsert */);
    },
    indent: function (cm, actionArgs) {
        cm.indentLine(cm.getCursor().line, actionArgs.indentRight);
    },
    exitInsertMode: exitInsertMode
};
function defineAction(name, fn) {
    actions[name] = fn;
}
function clipCursorToContent(cm, cur, oldCur) {
    var vim = cm.state.vim;
    var includeLineBreak = vim.insertMode || vim.visualMode;
    var line = Math.min(Math.max(cm.firstLine(), cur.line), cm.lastLine());
    var text = cm.getLine(line);
    var maxCh = text.length - 1 + Number(!!includeLineBreak);
    var ch = Math.min(Math.max(0, cur.ch), maxCh);
    var charCode = text.charCodeAt(ch);
    if (0xDC00 <= charCode && charCode <= 0xDFFF) {
        var direction = 1;
        if (oldCur && oldCur.line == line && oldCur.ch > ch) {
            direction = -1;
        }
        ch += direction;
        if (ch > maxCh)
            ch -= 2;
    }
    return new Pos(line, ch);
}
function copyArgs(args) {
    var ret = {};
    for (var prop in args) {
        if (args.hasOwnProperty(prop)) {
            ret[prop] = args[prop];
        }
    }
    return ret;
}
function offsetCursor(cur, offsetLine, offsetCh) {
    if (typeof offsetLine === 'object') {
        offsetCh = offsetLine.ch;
        offsetLine = offsetLine.line;
    }
    return new Pos(cur.line + offsetLine, cur.ch + offsetCh);
}
function commandMatches(keys, keyMap, context, inputState) {
    if (inputState.operator)
        context = "operatorPending";
    var match, partial = [], full = [];
    var startIndex = noremap ? keyMap.length - defaultKeymapLength : 0;
    for (var i = startIndex; i < keyMap.length; i++) {
        var command = keyMap[i];
        if (context == 'insert' && command.context != 'insert' ||
            (command.context && command.context != context) ||
            inputState.operator && command.type == 'action' ||
            !(match = commandMatch(keys, command.keys))) {
            continue;
        }
        if (match == 'partial') {
            partial.push(command);
        }
        if (match == 'full') {
            full.push(command);
        }
    }
    return {
        partial: partial.length && partial,
        full: full.length && full
    };
}
function commandMatch(pressed, mapped) {
    var isLastCharacter = mapped.slice(-11) == '<character>';
    var isLastRegister = mapped.slice(-10) == '<register>';
    if (isLastCharacter || isLastRegister) {
        var prefixLen = mapped.length - (isLastCharacter ? 11 : 10);
        var pressedPrefix = pressed.slice(0, prefixLen);
        var mappedPrefix = mapped.slice(0, prefixLen);
        return pressedPrefix == mappedPrefix && pressed.length > prefixLen ? 'full' :
            mappedPrefix.indexOf(pressedPrefix) == 0 ? 'partial' : false;
    }
    else {
        return pressed == mapped ? 'full' :
            mapped.indexOf(pressed) == 0 ? 'partial' : false;
    }
}
function lastChar(keys) {
    var match = /^.*(<[^>]+>)$/.exec(keys);
    var selectedCharacter = match ? match[1] : keys.slice(-1);
    if (selectedCharacter.length > 1) {
        switch (selectedCharacter) {
            case '<CR>':
                selectedCharacter = '\n';
                break;
            case '<Space>':
                selectedCharacter = ' ';
                break;
            default:
                selectedCharacter = '';
                break;
        }
    }
    return selectedCharacter;
}
function repeatFn(cm, fn, repeat) {
    return function () {
        for (var i = 0; i < repeat; i++) {
            fn(cm);
        }
    };
}
function copyCursor(cur) {
    return new Pos(cur.line, cur.ch);
}
function cursorEqual(cur1, cur2) {
    return cur1.ch == cur2.ch && cur1.line == cur2.line;
}
function cursorIsBefore(cur1, cur2) {
    if (cur1.line < cur2.line) {
        return true;
    }
    if (cur1.line == cur2.line && cur1.ch < cur2.ch) {
        return true;
    }
    return false;
}
function cursorMin(cur1, cur2) {
    if (arguments.length > 2) {
        cur2 = cursorMin.apply(undefined, Array.prototype.slice.call(arguments, 1));
    }
    return cursorIsBefore(cur1, cur2) ? cur1 : cur2;
}
function cursorMax(cur1, cur2) {
    if (arguments.length > 2) {
        cur2 = cursorMax.apply(undefined, Array.prototype.slice.call(arguments, 1));
    }
    return cursorIsBefore(cur1, cur2) ? cur2 : cur1;
}
function cursorIsBetween(cur1, cur2, cur3) {
    var cur1before2 = cursorIsBefore(cur1, cur2);
    var cur2before3 = cursorIsBefore(cur2, cur3);
    return cur1before2 && cur2before3;
}
function lineLength(cm, lineNum) {
    return cm.getLine(lineNum).length;
}
function trim(s) {
    if (s.trim) {
        return s.trim();
    }
    return s.replace(/^\s+|\s+$/g, '');
}
function escapeRegex(s) {
    return s.replace(/([.?*+$\[\]\/\\(){}|\-])/g, '\\$1');
}
function extendLineToColumn(cm, lineNum, column) {
    var endCh = lineLength(cm, lineNum);
    var spaces = new Array(column - endCh + 1).join(' ');
    cm.setCursor(new Pos(lineNum, endCh));
    cm.replaceRange(spaces, cm.getCursor());
}
function selectBlock(cm, selectionEnd) {
    var selections = [], ranges = cm.listSelections();
    var head = copyCursor(cm.clipPos(selectionEnd));
    var isClipped = !cursorEqual(selectionEnd, head);
    var curHead = cm.getCursor('head');
    var primIndex = getIndex(ranges, curHead);
    var wasClipped = cursorEqual(ranges[primIndex].head, ranges[primIndex].anchor);
    var max = ranges.length - 1;
    var index = max - primIndex > primIndex ? max : 0;
    var base = ranges[index].anchor;
    var firstLine = Math.min(base.line, head.line);
    var lastLine = Math.max(base.line, head.line);
    var baseCh = base.ch, headCh = head.ch;
    var dir = ranges[index].head.ch - baseCh;
    var newDir = headCh - baseCh;
    if (dir > 0 && newDir <= 0) {
        baseCh++;
        if (!isClipped) {
            headCh--;
        }
    }
    else if (dir < 0 && newDir >= 0) {
        baseCh--;
        if (!wasClipped) {
            headCh++;
        }
    }
    else if (dir < 0 && newDir == -1) {
        baseCh--;
        headCh++;
    }
    for (var line = firstLine; line <= lastLine; line++) {
        var range = { anchor: new Pos(line, baseCh), head: new Pos(line, headCh) };
        selections.push(range);
    }
    cm.setSelections(selections);
    selectionEnd.ch = headCh;
    base.ch = baseCh;
    return base;
}
function selectForInsert(cm, head, height) {
    var sel = [];
    for (var i = 0; i < height; i++) {
        var lineHead = offsetCursor(head, i, 0);
        sel.push({ anchor: lineHead, head: lineHead });
    }
    cm.setSelections(sel, 0);
}
function getIndex(ranges, cursor, end) {
    for (var i = 0; i < ranges.length; i++) {
        var atAnchor = end != 'head' && cursorEqual(ranges[i].anchor, cursor);
        var atHead = end != 'anchor' && cursorEqual(ranges[i].head, cursor);
        if (atAnchor || atHead) {
            return i;
        }
    }
    return -1;
}
function getSelectedAreaRange(cm, vim) {
    var lastSelection = vim.lastSelection;
    var getCurrentSelectedAreaRange = function () {
        var selections = cm.listSelections();
        var start = selections[0];
        var end = selections[selections.length - 1];
        var selectionStart = cursorIsBefore(start.anchor, start.head) ? start.anchor : start.head;
        var selectionEnd = cursorIsBefore(end.anchor, end.head) ? end.head : end.anchor;
        return [selectionStart, selectionEnd];
    };
    var getLastSelectedAreaRange = function () {
        var selectionStart = cm.getCursor();
        var selectionEnd = cm.getCursor();
        var block = lastSelection.visualBlock;
        if (block) {
            var width = block.width;
            var height = block.height;
            selectionEnd = new Pos(selectionStart.line + height, selectionStart.ch + width);
            var selections = [];
            for (var i = selectionStart.line; i < selectionEnd.line; i++) {
                var anchor = new Pos(i, selectionStart.ch);
                var head = new Pos(i, selectionEnd.ch);
                var range = { anchor: anchor, head: head };
                selections.push(range);
            }
            cm.setSelections(selections);
        }
        else {
            var start = lastSelection.anchorMark.find();
            var end = lastSelection.headMark.find();
            var line = end.line - start.line;
            var ch = end.ch - start.ch;
            selectionEnd = { line: selectionEnd.line + line, ch: line ? selectionEnd.ch : ch + selectionEnd.ch };
            if (lastSelection.visualLine) {
                selectionStart = new Pos(selectionStart.line, 0);
                selectionEnd = new Pos(selectionEnd.line, lineLength(cm, selectionEnd.line));
            }
            cm.setSelection(selectionStart, selectionEnd);
        }
        return [selectionStart, selectionEnd];
    };
    if (!vim.visualMode) {
        return getLastSelectedAreaRange();
    }
    else {
        return getCurrentSelectedAreaRange();
    }
}
function updateLastSelection(cm, vim) {
    var anchor = vim.sel.anchor;
    var head = vim.sel.head;
    if (vim.lastPastedText) {
        head = cm.posFromIndex(cm.indexFromPos(anchor) + vim.lastPastedText.length);
        vim.lastPastedText = null;
    }
    vim.lastSelection = { 'anchorMark': cm.setBookmark(anchor),
        'headMark': cm.setBookmark(head),
        'anchor': copyCursor(anchor),
        'head': copyCursor(head),
        'visualMode': vim.visualMode,
        'visualLine': vim.visualLine,
        'visualBlock': vim.visualBlock };
}
function expandSelection(cm, start, end, move) {
    var sel = cm.state.vim.sel;
    var head = move ? start : sel.head;
    var anchor = move ? start : sel.anchor;
    var tmp;
    if (cursorIsBefore(end, start)) {
        tmp = end;
        end = start;
        start = tmp;
    }
    if (cursorIsBefore(head, anchor)) {
        head = cursorMin(start, head);
        anchor = cursorMax(anchor, end);
    }
    else {
        anchor = cursorMin(start, anchor);
        head = cursorMax(head, end);
        head = offsetCursor(head, 0, -1);
        if (head.ch == -1 && head.line != cm.firstLine()) {
            head = new Pos(head.line - 1, lineLength(cm, head.line - 1));
        }
    }
    return [anchor, head];
}
function updateCmSelection(cm, sel, mode) {
    var vim = cm.state.vim;
    sel = sel || vim.sel;
    var mode = mode ||
        vim.visualLine ? 'line' : vim.visualBlock ? 'block' : 'char';
    var cmSel = makeCmSelection(cm, sel, mode);
    cm.setSelections(cmSel.ranges, cmSel.primary);
}
function makeCmSelection(cm, sel, mode, exclusive) {
    var head = copyCursor(sel.head);
    var anchor = copyCursor(sel.anchor);
    if (mode == 'char') {
        var headOffset = !exclusive && !cursorIsBefore(sel.head, sel.anchor) ? 1 : 0;
        var anchorOffset = cursorIsBefore(sel.head, sel.anchor) ? 1 : 0;
        head = offsetCursor(sel.head, 0, headOffset);
        anchor = offsetCursor(sel.anchor, 0, anchorOffset);
        return {
            ranges: [{ anchor: anchor, head: head }],
            primary: 0
        };
    }
    else if (mode == 'line') {
        if (!cursorIsBefore(sel.head, sel.anchor)) {
            anchor.ch = 0;
            var lastLine = cm.lastLine();
            if (head.line > lastLine) {
                head.line = lastLine;
            }
            head.ch = lineLength(cm, head.line);
        }
        else {
            head.ch = 0;
            anchor.ch = lineLength(cm, anchor.line);
        }
        return {
            ranges: [{ anchor: anchor, head: head }],
            primary: 0
        };
    }
    else if (mode == 'block') {
        var top = Math.min(anchor.line, head.line), fromCh = anchor.ch, bottom = Math.max(anchor.line, head.line), toCh = head.ch;
        if (fromCh < toCh) {
            toCh += 1;
        }
        else {
            fromCh += 1;
        }
        ;
        var height = bottom - top + 1;
        var primary = head.line == top ? 0 : height - 1;
        var ranges = [];
        for (var i = 0; i < height; i++) {
            ranges.push({
                anchor: new Pos(top + i, fromCh),
                head: new Pos(top + i, toCh)
            });
        }
        return {
            ranges: ranges,
            primary: primary
        };
    }
}
function getHead(cm) {
    var cur = cm.getCursor('head');
    if (cm.getSelection().length == 1) {
        cur = cursorMin(cur, cm.getCursor('anchor'));
    }
    return cur;
}
function exitVisualMode(cm, moveHead) {
    var vim = cm.state.vim;
    if (moveHead !== false) {
        cm.setCursor(clipCursorToContent(cm, vim.sel.head));
    }
    updateLastSelection(cm, vim);
    vim.visualMode = false;
    vim.visualLine = false;
    vim.visualBlock = false;
    if (!vim.insertMode)
        CodeMirror.signal(cm, "vim-mode-change", { mode: "normal" });
}
function clipToLine(cm, curStart, curEnd) {
    var selection = cm.getRange(curStart, curEnd);
    if (/\n\s*$/.test(selection)) {
        var lines = selection.split('\n');
        lines.pop();
        var line;
        for (var line = lines.pop(); lines.length > 0 && line && isWhiteSpaceString(line); line = lines.pop()) {
            curEnd.line--;
            curEnd.ch = 0;
        }
        if (line) {
            curEnd.line--;
            curEnd.ch = lineLength(cm, curEnd.line);
        }
        else {
            curEnd.ch = 0;
        }
    }
}
function expandSelectionToLine(_cm, curStart, curEnd) {
    curStart.ch = 0;
    curEnd.ch = 0;
    curEnd.line++;
}
function findFirstNonWhiteSpaceCharacter(text) {
    if (!text) {
        return 0;
    }
    var firstNonWS = text.search(/\S/);
    return firstNonWS == -1 ? text.length : firstNonWS;
}
function expandWordUnderCursor(cm, _a, cursor) {
    var inclusive = _a.inclusive, innerWord = _a.innerWord, bigWord = _a.bigWord, noSymbol = _a.noSymbol, multiline = _a.multiline;
    var cur = cursor || getHead(cm);
    var line = cm.getLine(cur.line);
    var endLine = line;
    var startLineNumber = cur.line;
    var endLineNumber = startLineNumber;
    var idx = cur.ch;
    var wordOnNextLine;
    var test = noSymbol ? wordCharTest[0] : bigWordCharTest[0];
    if (innerWord && /\s/.test(line.charAt(idx))) {
        test = function (ch) { return /\s/.test(ch); };
    }
    else {
        while (!test(line.charAt(idx))) {
            idx++;
            if (idx >= line.length) {
                if (!multiline)
                    return null;
                idx--;
                wordOnNextLine = findWord(cm, cur, true, bigWord, true);
                break;
            }
        }
        if (bigWord) {
            test = bigWordCharTest[0];
        }
        else {
            test = wordCharTest[0];
            if (!test(line.charAt(idx))) {
                test = wordCharTest[1];
            }
        }
    }
    var end = idx, start = idx;
    while (test(line.charAt(start)) && start >= 0) {
        start--;
    }
    start++;
    if (wordOnNextLine) {
        end = wordOnNextLine.to;
        endLineNumber = wordOnNextLine.line;
        endLine = cm.getLine(endLineNumber);
        if (!endLine && end == 0)
            end++;
    }
    else {
        while (test(line.charAt(end)) && end < line.length) {
            end++;
        }
    }
    if (inclusive) {
        var wordEnd = end;
        var startsWithSpace = cur.ch <= start && /\s/.test(line.charAt(cur.ch));
        if (!startsWithSpace) {
            while (/\s/.test(endLine.charAt(end)) && end < endLine.length) {
                end++;
            }
        }
        if (wordEnd == end || startsWithSpace) {
            var wordStart = start;
            while (/\s/.test(line.charAt(start - 1)) && start > 0) {
                start--;
            }
            if (!start && !startsWithSpace) {
                start = wordStart;
            }
        }
    }
    return { start: new Pos(startLineNumber, start), end: new Pos(endLineNumber, end) };
}
function expandTagUnderCursor(cm, head, inclusive) {
    var cur = head;
    if (!CodeMirror.findMatchingTag || !CodeMirror.findEnclosingTag) {
        return { start: cur, end: cur };
    }
    var tags = CodeMirror.findMatchingTag(cm, head) || CodeMirror.findEnclosingTag(cm, head);
    if (!tags || !tags.open || !tags.close) {
        return { start: cur, end: cur };
    }
    if (inclusive) {
        return { start: tags.open.from, end: tags.close.to };
    }
    return { start: tags.open.to, end: tags.close.from };
}
function recordJumpPosition(cm, oldCur, newCur) {
    if (!cursorEqual(oldCur, newCur)) {
        vimGlobalState.jumpList.add(cm, oldCur, newCur);
    }
}
function recordLastCharacterSearch(increment, args) {
    vimGlobalState.lastCharacterSearch.increment = increment;
    vimGlobalState.lastCharacterSearch.forward = args.forward;
    vimGlobalState.lastCharacterSearch.selectedCharacter = args.selectedCharacter;
}
var symbolToMode = {
    '(': 'bracket', ')': 'bracket', '{': 'bracket', '}': 'bracket',
    '[': 'section', ']': 'section',
    '*': 'comment', '/': 'comment',
    'm': 'method', 'M': 'method',
    '#': 'preprocess'
};
var findSymbolModes = {
    bracket: {
        isComplete: function (state) {
            if (state.nextCh === state.symb) {
                state.depth++;
                if (state.depth >= 1)
                    return true;
            }
            else if (state.nextCh === state.reverseSymb) {
                state.depth--;
            }
            return false;
        }
    },
    section: {
        init: function (state) {
            state.curMoveThrough = true;
            state.symb = (state.forward ? ']' : '[') === state.symb ? '{' : '}';
        },
        isComplete: function (state) {
            return state.index === 0 && state.nextCh === state.symb;
        }
    },
    comment: {
        isComplete: function (state) {
            var found = state.lastCh === '*' && state.nextCh === '/';
            state.lastCh = state.nextCh;
            return found;
        }
    },
    method: {
        init: function (state) {
            state.symb = (state.symb === 'm' ? '{' : '}');
            state.reverseSymb = state.symb === '{' ? '}' : '{';
        },
        isComplete: function (state) {
            if (state.nextCh === state.symb)
                return true;
            return false;
        }
    },
    preprocess: {
        init: function (state) {
            state.index = 0;
        },
        isComplete: function (state) {
            if (state.nextCh === '#') {
                var token = state.lineText.match(/^#(\w+)/)[1];
                if (token === 'endif') {
                    if (state.forward && state.depth === 0) {
                        return true;
                    }
                    state.depth++;
                }
                else if (token === 'if') {
                    if (!state.forward && state.depth === 0) {
                        return true;
                    }
                    state.depth--;
                }
                if (token === 'else' && state.depth === 0)
                    return true;
            }
            return false;
        }
    }
};
function findSymbol(cm, repeat, forward, symb) {
    var cur = copyCursor(cm.getCursor());
    var increment = forward ? 1 : -1;
    var endLine = forward ? cm.lineCount() : -1;
    var curCh = cur.ch;
    var line = cur.line;
    var lineText = cm.getLine(line);
    var state = {
        lineText: lineText,
        nextCh: lineText.charAt(curCh),
        lastCh: null,
        index: curCh,
        symb: symb,
        reverseSymb: (forward ? { ')': '(', '}': '{' } : { '(': ')', '{': '}' })[symb],
        forward: forward,
        depth: 0,
        curMoveThrough: false
    };
    var mode = symbolToMode[symb];
    if (!mode)
        return cur;
    var init = findSymbolModes[mode].init;
    var isComplete = findSymbolModes[mode].isComplete;
    if (init) {
        init(state);
    }
    while (line !== endLine && repeat) {
        state.index += increment;
        state.nextCh = state.lineText.charAt(state.index);
        if (!state.nextCh) {
            line += increment;
            state.lineText = cm.getLine(line) || '';
            if (increment > 0) {
                state.index = 0;
            }
            else {
                var lineLen = state.lineText.length;
                state.index = (lineLen > 0) ? (lineLen - 1) : 0;
            }
            state.nextCh = state.lineText.charAt(state.index);
        }
        if (isComplete(state)) {
            cur.line = line;
            cur.ch = state.index;
            repeat--;
        }
    }
    if (state.nextCh || state.curMoveThrough) {
        return new Pos(line, state.index);
    }
    return cur;
}
function findWord(cm, cur, forward, bigWord, emptyLineIsWord) {
    var lineNum = cur.line;
    var pos = cur.ch;
    var line = cm.getLine(lineNum);
    var dir = forward ? 1 : -1;
    var charTests = bigWord ? bigWordCharTest : wordCharTest;
    if (emptyLineIsWord && line == '') {
        lineNum += dir;
        line = cm.getLine(lineNum);
        if (!isLine(cm, lineNum)) {
            return null;
        }
        pos = (forward) ? 0 : line.length;
    }
    while (true) {
        if (emptyLineIsWord && line == '') {
            return { from: 0, to: 0, line: lineNum };
        }
        var stop = (dir > 0) ? line.length : -1;
        var wordStart = stop, wordEnd = stop;
        while (pos != stop) {
            var foundWord = false;
            for (var i = 0; i < charTests.length && !foundWord; ++i) {
                if (charTests[i](line.charAt(pos))) {
                    wordStart = pos;
                    while (pos != stop && charTests[i](line.charAt(pos))) {
                        pos += dir;
                    }
                    wordEnd = pos;
                    foundWord = wordStart != wordEnd;
                    if (wordStart == cur.ch && lineNum == cur.line &&
                        wordEnd == wordStart + dir) {
                        continue;
                    }
                    else {
                        return {
                            from: Math.min(wordStart, wordEnd + 1),
                            to: Math.max(wordStart, wordEnd),
                            line: lineNum
                        };
                    }
                }
            }
            if (!foundWord) {
                pos += dir;
            }
        }
        lineNum += dir;
        if (!isLine(cm, lineNum)) {
            return null;
        }
        line = cm.getLine(lineNum);
        pos = (dir > 0) ? 0 : line.length;
    }
}
function moveToWord(cm, cur, repeat, forward, wordEnd, bigWord) {
    var curStart = copyCursor(cur);
    var words = [];
    if (forward && !wordEnd || !forward && wordEnd) {
        repeat++;
    }
    var emptyLineIsWord = !(forward && wordEnd);
    for (var i = 0; i < repeat; i++) {
        var word = findWord(cm, cur, forward, bigWord, emptyLineIsWord);
        if (!word) {
            var eodCh = lineLength(cm, cm.lastLine());
            words.push(forward
                ? { line: cm.lastLine(), from: eodCh, to: eodCh }
                : { line: 0, from: 0, to: 0 });
            break;
        }
        words.push(word);
        cur = new Pos(word.line, forward ? (word.to - 1) : word.from);
    }
    var shortCircuit = words.length != repeat;
    var firstWord = words[0];
    var lastWord = words.pop();
    if (forward && !wordEnd) {
        if (!shortCircuit && (firstWord.from != curStart.ch || firstWord.line != curStart.line)) {
            lastWord = words.pop();
        }
        return new Pos(lastWord.line, lastWord.from);
    }
    else if (forward && wordEnd) {
        return new Pos(lastWord.line, lastWord.to - 1);
    }
    else if (!forward && wordEnd) {
        if (!shortCircuit && (firstWord.to != curStart.ch || firstWord.line != curStart.line)) {
            lastWord = words.pop();
        }
        return new Pos(lastWord.line, lastWord.to);
    }
    else {
        return new Pos(lastWord.line, lastWord.from);
    }
}
function moveToEol(cm, head, motionArgs, vim, keepHPos) {
    var cur = head;
    var retval = new Pos(cur.line + motionArgs.repeat - 1, Infinity);
    var end = cm.clipPos(retval);
    end.ch--;
    if (!keepHPos) {
        vim.lastHPos = Infinity;
        vim.lastHSPos = cm.charCoords(end, 'div').left;
    }
    return retval;
}
function moveToCharacter(cm, repeat, forward, character, head) {
    var cur = head || cm.getCursor();
    var start = cur.ch;
    var idx;
    for (var i = 0; i < repeat; i++) {
        var line = cm.getLine(cur.line);
        idx = charIdxInLine(start, line, character, forward, true);
        if (idx == -1) {
            return null;
        }
        start = idx;
    }
    return new Pos(cm.getCursor().line, idx);
}
function moveToColumn(cm, repeat) {
    var line = cm.getCursor().line;
    return clipCursorToContent(cm, new Pos(line, repeat - 1));
}
function updateMark(cm, vim, markName, pos) {
    if (!inArray(markName, validMarks) && !latinCharRegex.test(markName)) {
        return;
    }
    if (vim.marks[markName]) {
        vim.marks[markName].clear();
    }
    vim.marks[markName] = cm.setBookmark(pos);
}
function charIdxInLine(start, line, character, forward, includeChar) {
    var idx;
    if (forward) {
        idx = line.indexOf(character, start + 1);
        if (idx != -1 && !includeChar) {
            idx -= 1;
        }
    }
    else {
        idx = line.lastIndexOf(character, start - 1);
        if (idx != -1 && !includeChar) {
            idx += 1;
        }
    }
    return idx;
}
function findParagraph(cm, head, repeat, dir, inclusive) {
    var line = head.line;
    var min = cm.firstLine();
    var max = cm.lastLine();
    var start, end, i = line;
    function isEmpty(i) { return !/\S/.test(cm.getLine(i)); } // ace_patch
    function isBoundary(i, dir, any) {
        if (any) {
            return isEmpty(i) != isEmpty(i + dir);
        }
        return !isEmpty(i) && isEmpty(i + dir);
    }
    function skipFold(i) {
        dir = dir > 0 ? 1 : -1;
        var foldLine = cm.ace.session.getFoldLine(i);
        if (foldLine) {
            if (i + dir > foldLine.start.row && i + dir < foldLine.end.row)
                dir = (dir > 0 ? foldLine.end.row : foldLine.start.row) - i;
        }
    }
    if (dir) {
        while (min <= i && i <= max && repeat > 0) {
            skipFold(i);
            if (isBoundary(i, dir)) {
                repeat--;
            }
            i += dir;
        }
        return new Pos(i, 0);
    }
    var vim = cm.state.vim;
    if (vim.visualLine && isBoundary(line, 1, true)) {
        var anchor = vim.sel.anchor;
        if (isBoundary(anchor.line, -1, true)) {
            if (!inclusive || anchor.line != line) {
                line += 1;
            }
        }
    }
    var startState = isEmpty(line);
    for (i = line; i <= max && repeat; i++) {
        if (isBoundary(i, 1, true)) {
            if (!inclusive || isEmpty(i) != startState) {
                repeat--;
            }
        }
    }
    end = new Pos(i, 0);
    if (i > max && !startState) {
        startState = true;
    }
    else {
        inclusive = false;
    }
    for (i = line; i > min; i--) {
        if (!inclusive || isEmpty(i) == startState || i == line) {
            if (isBoundary(i, -1, true)) {
                break;
            }
        }
    }
    start = new Pos(i, 0);
    return { start: start, end: end };
}
function getSentence(cm, cur, repeat, dir, inclusive /*includes whitespace*/) {
    function nextChar(curr) {
        if (curr.pos + curr.dir < 0 || curr.pos + curr.dir >= curr.line.length) {
            curr.line = null;
        }
        else {
            curr.pos += curr.dir;
        }
    }
    function forward(cm, ln, pos, dir) {
        var line = cm.getLine(ln);
        var curr = {
            line: line,
            ln: ln,
            pos: pos,
            dir: dir,
        };
        if (curr.line === "") {
            return { ln: curr.ln, pos: curr.pos };
        }
        var lastSentencePos = curr.pos;
        nextChar(curr);
        while (curr.line !== null) {
            lastSentencePos = curr.pos;
            if (isEndOfSentenceSymbol(curr.line[curr.pos])) {
                if (!inclusive) {
                    return { ln: curr.ln, pos: curr.pos + 1 };
                }
                else {
                    nextChar(curr);
                    while (curr.line !== null) {
                        if (isWhiteSpaceString(curr.line[curr.pos])) {
                            lastSentencePos = curr.pos;
                            nextChar(curr);
                        }
                        else {
                            break;
                        }
                    }
                    return { ln: curr.ln, pos: lastSentencePos + 1 };
                }
            }
            nextChar(curr);
        }
        return { ln: curr.ln, pos: lastSentencePos + 1 };
    }
    function reverse(cm, ln, pos, dir) {
        var line = cm.getLine(ln);
        var curr = {
            line: line,
            ln: ln,
            pos: pos,
            dir: dir,
        };
        if (curr.line === "") {
            return { ln: curr.ln, pos: curr.pos };
        }
        var lastSentencePos = curr.pos;
        nextChar(curr);
        while (curr.line !== null) {
            if (!isWhiteSpaceString(curr.line[curr.pos]) && !isEndOfSentenceSymbol(curr.line[curr.pos])) {
                lastSentencePos = curr.pos;
            }
            else if (isEndOfSentenceSymbol(curr.line[curr.pos])) {
                if (!inclusive) {
                    return { ln: curr.ln, pos: lastSentencePos };
                }
                else {
                    if (isWhiteSpaceString(curr.line[curr.pos + 1])) {
                        return { ln: curr.ln, pos: curr.pos + 1 };
                    }
                    else {
                        return { ln: curr.ln, pos: lastSentencePos };
                    }
                }
            }
            nextChar(curr);
        }
        curr.line = line;
        if (inclusive && isWhiteSpaceString(curr.line[curr.pos])) {
            return { ln: curr.ln, pos: curr.pos };
        }
        else {
            return { ln: curr.ln, pos: lastSentencePos };
        }
    }
    var curr_index = {
        ln: cur.line,
        pos: cur.ch,
    };
    while (repeat > 0) {
        if (dir < 0) {
            curr_index = reverse(cm, curr_index.ln, curr_index.pos, dir);
        }
        else {
            curr_index = forward(cm, curr_index.ln, curr_index.pos, dir);
        }
        repeat--;
    }
    return new Pos(curr_index.ln, curr_index.pos);
}
function findSentence(cm, cur, repeat, dir) {
    function nextChar(cm, idx) {
        if (idx.pos + idx.dir < 0 || idx.pos + idx.dir >= idx.line.length) {
            idx.ln += idx.dir;
            if (!isLine(cm, idx.ln)) {
                idx.line = null;
                idx.ln = null;
                idx.pos = null;
                return;
            }
            idx.line = cm.getLine(idx.ln);
            idx.pos = (idx.dir > 0) ? 0 : idx.line.length - 1;
        }
        else {
            idx.pos += idx.dir;
        }
    }
    function forward(cm, ln, pos, dir) {
        var line = cm.getLine(ln);
        var stop = (line === "");
        var curr = {
            line: line,
            ln: ln,
            pos: pos,
            dir: dir,
        };
        var last_valid = {
            ln: curr.ln,
            pos: curr.pos,
        };
        var skip_empty_lines = (curr.line === "");
        nextChar(cm, curr);
        while (curr.line !== null) {
            last_valid.ln = curr.ln;
            last_valid.pos = curr.pos;
            if (curr.line === "" && !skip_empty_lines) {
                return { ln: curr.ln, pos: curr.pos, };
            }
            else if (stop && curr.line !== "" && !isWhiteSpaceString(curr.line[curr.pos])) {
                return { ln: curr.ln, pos: curr.pos, };
            }
            else if (isEndOfSentenceSymbol(curr.line[curr.pos])
                && !stop
                && (curr.pos === curr.line.length - 1
                    || isWhiteSpaceString(curr.line[curr.pos + 1]))) {
                stop = true;
            }
            nextChar(cm, curr);
        }
        var line = cm.getLine(last_valid.ln);
        last_valid.pos = 0;
        for (var i = line.length - 1; i >= 0; --i) {
            if (!isWhiteSpaceString(line[i])) {
                last_valid.pos = i;
                break;
            }
        }
        return last_valid;
    }
    function reverse(cm, ln, pos, dir) {
        var line = cm.getLine(ln);
        var curr = {
            line: line,
            ln: ln,
            pos: pos,
            dir: dir,
        };
        var last_valid = {
            ln: curr.ln,
            pos: null,
        };
        var skip_empty_lines = (curr.line === "");
        nextChar(cm, curr);
        while (curr.line !== null) {
            if (curr.line === "" && !skip_empty_lines) {
                if (last_valid.pos !== null) {
                    return last_valid;
                }
                else {
                    return { ln: curr.ln, pos: curr.pos };
                }
            }
            else if (isEndOfSentenceSymbol(curr.line[curr.pos])
                && last_valid.pos !== null
                && !(curr.ln === last_valid.ln && curr.pos + 1 === last_valid.pos)) {
                return last_valid;
            }
            else if (curr.line !== "" && !isWhiteSpaceString(curr.line[curr.pos])) {
                skip_empty_lines = false;
                last_valid = { ln: curr.ln, pos: curr.pos };
            }
            nextChar(cm, curr);
        }
        var line = cm.getLine(last_valid.ln);
        last_valid.pos = 0;
        for (var i = 0; i < line.length; ++i) {
            if (!isWhiteSpaceString(line[i])) {
                last_valid.pos = i;
                break;
            }
        }
        return last_valid;
    }
    var curr_index = {
        ln: cur.line,
        pos: cur.ch,
    };
    while (repeat > 0) {
        if (dir < 0) {
            curr_index = reverse(cm, curr_index.ln, curr_index.pos, dir);
        }
        else {
            curr_index = forward(cm, curr_index.ln, curr_index.pos, dir);
        }
        repeat--;
    }
    return new Pos(curr_index.ln, curr_index.pos);
}
function selectCompanionObject(cm, head, symb, inclusive) {
    var cur = head, start, end;
    var bracketRegexp = ({
        '(': /[()]/, ')': /[()]/,
        '[': /[[\]]/, ']': /[[\]]/,
        '{': /[{}]/, '}': /[{}]/,
        '<': /[<>]/, '>': /[<>]/
    })[symb];
    var openSym = ({
        '(': '(', ')': '(',
        '[': '[', ']': '[',
        '{': '{', '}': '{',
        '<': '<', '>': '<'
    })[symb];
    var curChar = cm.getLine(cur.line).charAt(cur.ch);
    var offset = curChar === openSym ? 1 : 0;
    start = cm.scanForBracket(new Pos(cur.line, cur.ch + offset), -1, undefined, { 'bracketRegex': bracketRegexp });
    end = cm.scanForBracket(new Pos(cur.line, cur.ch + offset), 1, undefined, { 'bracketRegex': bracketRegexp });
    if (!start || !end)
        return null;
    start = start.pos;
    end = end.pos;
    if ((start.line == end.line && start.ch > end.ch)
        || (start.line > end.line)) {
        var tmp = start;
        start = end;
        end = tmp;
    }
    if (inclusive) {
        end.ch += 1;
    }
    else {
        start.ch += 1;
    }
    return { start: start, end: end };
}
function findBeginningAndEnd(cm, head, symb, inclusive) {
    var cur = copyCursor(head);
    var line = cm.getLine(cur.line);
    var chars = line.split('');
    var start, end, i, len;
    var firstIndex = chars.indexOf(symb);
    if (cur.ch < firstIndex) {
        cur.ch = firstIndex;
    }
    else if (firstIndex < cur.ch && chars[cur.ch] == symb) {
        var stringAfter = /string/.test(cm.getTokenTypeAt(offsetCursor(head, 0, 1)));
        var stringBefore = /string/.test(cm.getTokenTypeAt(head));
        var isStringStart = stringAfter && !stringBefore;
        if (!isStringStart) {
            end = cur.ch; // assign end to the current cursor
            --cur.ch; // make sure to look backwards
        }
    }
    if (chars[cur.ch] == symb && !end) {
        start = cur.ch + 1; // assign start to ahead of the cursor
    }
    else {
        for (i = cur.ch; i > -1 && !start; i--) {
            if (chars[i] == symb) {
                start = i + 1;
            }
        }
    }
    if (start && !end) {
        for (i = start, len = chars.length; i < len && !end; i++) {
            if (chars[i] == symb) {
                end = i;
            }
        }
    }
    if (!start || !end) {
        return { start: cur, end: cur };
    }
    if (inclusive) {
        --start;
        ++end;
    }
    return {
        start: new Pos(cur.line, start),
        end: new Pos(cur.line, end)
    };
}
defineOption('pcre', true, 'boolean');
function SearchState() { }
SearchState.prototype = {
    getQuery: function () {
        return vimGlobalState.query;
    },
    setQuery: function (query) {
        vimGlobalState.query = query;
    },
    getOverlay: function () {
        return this.searchOverlay;
    },
    setOverlay: function (overlay) {
        this.searchOverlay = overlay;
    },
    isReversed: function () {
        return vimGlobalState.isReversed;
    },
    setReversed: function (reversed) {
        vimGlobalState.isReversed = reversed;
    },
    getScrollbarAnnotate: function () {
        return this.annotate;
    },
    setScrollbarAnnotate: function (annotate) {
        this.annotate = annotate;
    }
};
function getSearchState(cm) {
    var vim = cm.state.vim;
    return vim.searchState_ || (vim.searchState_ = new SearchState());
}
function splitBySlash(argString) {
    return splitBySeparator(argString, '/');
}
function findUnescapedSlashes(argString) {
    return findUnescapedSeparators(argString, '/');
}
function splitBySeparator(argString, separator) {
    var slashes = findUnescapedSeparators(argString, separator) || [];
    if (!slashes.length)
        return [];
    var tokens = [];
    if (slashes[0] !== 0)
        return;
    for (var i = 0; i < slashes.length; i++) {
        if (typeof slashes[i] == 'number')
            tokens.push(argString.substring(slashes[i] + 1, slashes[i + 1]));
    }
    return tokens;
}
function findUnescapedSeparators(str, separator) {
    if (!separator)
        separator = '/';
    var escapeNextChar = false;
    var slashes = [];
    for (var i = 0; i < str.length; i++) {
        var c = str.charAt(i);
        if (!escapeNextChar && c == separator) {
            slashes.push(i);
        }
        escapeNextChar = !escapeNextChar && (c == '\\');
    }
    return slashes;
}
function translateRegex(str) {
    var specials = '|(){';
    var unescape = '}';
    var escapeNextChar = false;
    var out = [];
    for (var i = -1; i < str.length; i++) {
        var c = str.charAt(i) || '';
        var n = str.charAt(i + 1) || '';
        var specialComesNext = (n && specials.indexOf(n) != -1);
        if (escapeNextChar) {
            if (c !== '\\' || !specialComesNext) {
                out.push(c);
            }
            escapeNextChar = false;
        }
        else {
            if (c === '\\') {
                escapeNextChar = true;
                if (n && unescape.indexOf(n) != -1) {
                    specialComesNext = true;
                }
                if (!specialComesNext || n === '\\') {
                    out.push(c);
                }
            }
            else {
                out.push(c);
                if (specialComesNext && n !== '\\') {
                    out.push('\\');
                }
            }
        }
    }
    return out.join('');
}
var charUnescapes = { '\\n': '\n', '\\r': '\r', '\\t': '\t' };
function translateRegexReplace(str) {
    var escapeNextChar = false;
    var out = [];
    for (var i = -1; i < str.length; i++) {
        var c = str.charAt(i) || '';
        var n = str.charAt(i + 1) || '';
        if (charUnescapes[c + n]) {
            out.push(charUnescapes[c + n]);
            i++;
        }
        else if (escapeNextChar) {
            out.push(c);
            escapeNextChar = false;
        }
        else {
            if (c === '\\') {
                escapeNextChar = true;
                if ((isNumber(n) || n === '$')) {
                    out.push('$');
                }
                else if (n !== '/' && n !== '\\') {
                    out.push('\\');
                }
            }
            else {
                if (c === '$') {
                    out.push('$');
                }
                out.push(c);
                if (n === '/') {
                    out.push('\\');
                }
            }
        }
    }
    return out.join('');
}
var unescapes = { '\\/': '/', '\\\\': '\\', '\\n': '\n', '\\r': '\r', '\\t': '\t', '\\&': '&' };
function unescapeRegexReplace(str) {
    var stream = new CodeMirror.StringStream(str);
    var output = [];
    while (!stream.eol()) {
        while (stream.peek() && stream.peek() != '\\') {
            output.push(stream.next());
        }
        var matched = false;
        for (var matcher in unescapes) {
            if (stream.match(matcher, true)) {
                matched = true;
                output.push(unescapes[matcher]);
                break;
            }
        }
        if (!matched) {
            output.push(stream.next());
        }
    }
    return output.join('');
}
function parseQuery(query, ignoreCase, smartCase) {
    var lastSearchRegister = vimGlobalState.registerController.getRegister('/');
    lastSearchRegister.setText(query);
    if (query instanceof RegExp) {
        return query;
    }
    var slashes = findUnescapedSlashes(query);
    var regexPart;
    var forceIgnoreCase;
    if (!slashes.length) {
        regexPart = query;
    }
    else {
        regexPart = query.substring(0, slashes[0]);
        var flagsPart = query.substring(slashes[0]);
        forceIgnoreCase = (flagsPart.indexOf('i') != -1);
    }
    if (!regexPart) {
        return null;
    }
    if (!getOption('pcre')) {
        regexPart = translateRegex(regexPart);
    }
    if (smartCase) {
        ignoreCase = (/^[^A-Z]*$/).test(regexPart);
    }
    var regexp = new RegExp(regexPart, (ignoreCase || forceIgnoreCase) ? 'im' : 'm');
    return regexp;
}
function dom(n) {
    if (typeof n === 'string')
        n = document.createElement(n);
    for (var a, i = 1; i < arguments.length; i++) {
        if (!(a = arguments[i]))
            continue;
        if (typeof a !== 'object')
            a = document.createTextNode(a);
        if (a.nodeType)
            n.appendChild(a);
        else
            for (var key in a) {
                if (!Object.prototype.hasOwnProperty.call(a, key))
                    continue;
                if (key[0] === '$')
                    n.style[key.slice(1)] = a[key];
                else
                    n.setAttribute(key, a[key]);
            }
    }
    return n;
}
function showConfirm(cm, template) {
    var pre = dom('div', { $color: 'red', $whiteSpace: 'pre', class: 'cm-vim-message' }, template);
    if (cm.openNotification) {
        cm.openNotification(pre, { bottom: true, duration: 5000 });
    }
    else {
        alert(pre.innerText);
    }
}
function makePrompt(prefix, desc) {
    return dom('div', { $display: 'flex' }, dom('span', { $fontFamily: 'monospace', $whiteSpace: 'pre', $flex: 1 }, prefix, dom('input', { type: 'text', autocorrect: 'off',
        autocapitalize: 'off', spellcheck: 'false', $width: '100%' })), desc && dom('span', { $color: '#888' }, desc));
}
function showPrompt(cm, options) {
    if (keyToKeyStack.length) {
        if (!options.value)
            options.value = '';
        virtualPrompt = options;
        return;
    }
    var template = makePrompt(options.prefix, options.desc);
    if (cm.openDialog) {
        cm.openDialog(template, options.onClose, {
            onKeyDown: options.onKeyDown, onKeyUp: options.onKeyUp,
            bottom: true, selectValueOnOpen: false, value: options.value
        });
    }
    else {
        var shortText = '';
        if (typeof options.prefix != "string" && options.prefix)
            shortText += options.prefix.textContent;
        if (options.desc)
            shortText += " " + options.desc;
        options.onClose(prompt(shortText, ''));
    }
}
function regexEqual(r1, r2) {
    if (r1 instanceof RegExp && r2 instanceof RegExp) {
        var props = ['global', 'multiline', 'ignoreCase', 'source'];
        for (var i = 0; i < props.length; i++) {
            var prop = props[i];
            if (r1[prop] !== r2[prop]) {
                return false;
            }
        }
        return true;
    }
    return false;
}
function updateSearchQuery(cm, rawQuery, ignoreCase, smartCase) {
    if (!rawQuery) {
        return;
    }
    var state = getSearchState(cm);
    var query = parseQuery(rawQuery, !!ignoreCase, !!smartCase);
    if (!query) {
        return;
    }
    highlightSearchMatches(cm, query);
    if (regexEqual(query, state.getQuery())) {
        return query;
    }
    state.setQuery(query);
    return query;
}
function searchOverlay(query) {
    if (query.source.charAt(0) == '^') {
        var matchSol = true;
    }
    return {
        token: function (stream) {
            if (matchSol && !stream.sol()) {
                stream.skipToEnd();
                return;
            }
            var match = stream.match(query, false);
            if (match) {
                if (match[0].length == 0) {
                    stream.next();
                    return 'searching';
                }
                if (!stream.sol()) {
                    stream.backUp(1);
                    if (!query.exec(stream.next() + match[0])) {
                        stream.next();
                        return null;
                    }
                }
                stream.match(query);
                return 'searching';
            }
            while (!stream.eol()) {
                stream.next();
                if (stream.match(query, false))
                    break;
            }
        },
        query: query
    };
}
var highlightTimeout = 0;
function highlightSearchMatches(cm, query) {
    clearTimeout(highlightTimeout);
    var searchState = getSearchState(cm);
    searchState.highlightTimeout = highlightTimeout;
    highlightTimeout = setTimeout(function () {
        if (!cm.state.vim)
            return;
        var searchState = getSearchState(cm);
        searchState.highlightTimeout = null;
        var overlay = searchState.getOverlay();
        if (!overlay || query != overlay.query) {
            if (overlay) {
                cm.removeOverlay(overlay);
            }
            overlay = searchOverlay(query);
            cm.addOverlay(overlay);
            if (cm.showMatchesOnScrollbar) {
                if (searchState.getScrollbarAnnotate()) {
                    searchState.getScrollbarAnnotate().clear();
                }
                searchState.setScrollbarAnnotate(cm.showMatchesOnScrollbar(query));
            }
            searchState.setOverlay(overlay);
        }
    }, 50);
}
function findNext(cm, prev, query, repeat) {
    if (repeat === undefined) {
        repeat = 1;
    }
    return cm.operation(function () {
        var pos = cm.getCursor();
        var cursor = cm.getSearchCursor(query, pos);
        for (var i = 0; i < repeat; i++) {
            var found = cursor.find(prev);
            if (i == 0 && found && cursorEqual(cursor.from(), pos)) {
                var lastEndPos = prev ? cursor.from() : cursor.to();
                found = cursor.find(prev);
                if (found && !found[0] && cursorEqual(cursor.from(), lastEndPos)) {
                    if (cm.getLine(lastEndPos.line).length == lastEndPos.ch)
                        found = cursor.find(prev);
                }
            }
            if (!found) {
                cursor = cm.getSearchCursor(query, (prev) ? new Pos(cm.lastLine()) : new Pos(cm.firstLine(), 0));
                if (!cursor.find(prev)) {
                    return;
                }
            }
        }
        return cursor.from();
    });
}
function findNextFromAndToInclusive(cm, prev, query, repeat, vim) {
    if (repeat === undefined) {
        repeat = 1;
    }
    return cm.operation(function () {
        var pos = cm.getCursor();
        var cursor = cm.getSearchCursor(query, pos);
        var found = cursor.find(!prev);
        if (!vim.visualMode && found && cursorEqual(cursor.from(), pos)) {
            cursor.find(!prev);
        }
        for (var i = 0; i < repeat; i++) {
            found = cursor.find(prev);
            if (!found) {
                cursor = cm.getSearchCursor(query, (prev) ? new Pos(cm.lastLine()) : new Pos(cm.firstLine(), 0));
                if (!cursor.find(prev)) {
                    return;
                }
            }
        }
        return [cursor.from(), cursor.to()];
    });
}
function clearSearchHighlight(cm) {
    var state = getSearchState(cm);
    if (state.highlightTimeout) {
        clearTimeout(state.highlightTimeout);
        state.highlightTimeout = null;
    }
    cm.removeOverlay(getSearchState(cm).getOverlay());
    state.setOverlay(null);
    if (state.getScrollbarAnnotate()) {
        state.getScrollbarAnnotate().clear();
        state.setScrollbarAnnotate(null);
    }
}
function isInRange(pos, start, end) {
    if (typeof pos != 'number') {
        pos = pos.line;
    }
    if (start instanceof Array) {
        return inArray(pos, start);
    }
    else {
        if (typeof end == 'number') {
            return (pos >= start && pos <= end);
        }
        else {
            return pos == start;
        }
    }
}
function getUserVisibleLines(cm) {
    var renderer = cm.ace.renderer;
    return {
        top: renderer.getFirstFullyVisibleRow(),
        bottom: renderer.getLastFullyVisibleRow()
    };
}
function getMarkPos(cm, vim, markName) {
    if (markName == '\'' || markName == '`') {
        return vimGlobalState.jumpList.find(cm, -1) || new Pos(0, 0);
    }
    else if (markName == '.') {
        return getLastEditPos(cm);
    }
    var mark = vim.marks[markName];
    return mark && mark.find();
}
function getLastEditPos(cm) {
    if (cm.getLastEditEnd) {
        return cm.getLastEditEnd();
    }
    var done = cm.doc.history.done;
    for (var i = done.length; i--;) {
        if (done[i].changes) {
            return copyCursor(done[i].changes[0].to);
        }
    }
}
var ExCommandDispatcher = function () {
    this.buildCommandMap_();
};
ExCommandDispatcher.prototype = {
    processCommand: function (cm, input, opt_params) {
        var that = this;
        cm.operation(function () {
            cm.curOp.isVimOp = true;
            that._processCommand(cm, input, opt_params);
        });
    },
    _processCommand: function (cm, input, opt_params) {
        var vim = cm.state.vim;
        var commandHistoryRegister = vimGlobalState.registerController.getRegister(':');
        var previousCommand = commandHistoryRegister.toString();
        var inputStream = new CodeMirror.StringStream(input);
        commandHistoryRegister.setText(input);
        var params = opt_params || {};
        params.input = input;
        try {
            this.parseInput_(cm, inputStream, params);
        }
        catch (e) {
            showConfirm(cm, e.toString());
            throw e;
        }
        if (vim.visualMode) {
            exitVisualMode(cm);
        }
        var command;
        var commandName;
        if (!params.commandName) {
            if (params.line !== undefined) {
                commandName = 'move';
            }
        }
        else {
            command = this.matchCommand_(params.commandName);
            if (command) {
                commandName = command.name;
                if (command.excludeFromCommandHistory) {
                    commandHistoryRegister.setText(previousCommand);
                }
                this.parseCommandArgs_(inputStream, params, command);
                if (command.type == 'exToKey') {
                    doKeyToKey(cm, command.toKeys, command);
                    return;
                }
                else if (command.type == 'exToEx') {
                    this.processCommand(cm, command.toInput);
                    return;
                }
            }
        }
        if (!commandName) {
            showConfirm(cm, 'Not an editor command ":' + input + '"');
            return;
        }
        try {
            exCommands[commandName](cm, params);
            if ((!command || !command.possiblyAsync) && params.callback) {
                params.callback();
            }
        }
        catch (e) {
            showConfirm(cm, e.toString());
            throw e;
        }
    },
    parseInput_: function (cm, inputStream, result) {
        inputStream.eatWhile(':');
        if (inputStream.eat('%')) {
            result.line = cm.firstLine();
            result.lineEnd = cm.lastLine();
        }
        else {
            result.line = this.parseLineSpec_(cm, inputStream);
            if (result.line !== undefined && inputStream.eat(',')) {
                result.lineEnd = this.parseLineSpec_(cm, inputStream);
            }
        }
        if (result.line == undefined) {
            if (cm.state.vim.visualMode) {
                var pos = getMarkPos(cm, cm.state.vim, '<');
                result.selectionLine = pos && pos.line;
                pos = getMarkPos(cm, cm.state.vim, '>');
                result.selectionLineEnd = pos && pos.line;
            }
            else {
                result.selectionLine = cm.getCursor().line;
            }
        }
        else {
            result.selectionLine = result.line;
            result.selectionLineEnd = result.lineEnd;
        }
        var commandMatch = inputStream.match(/^(\w+|!!|@@|[!#&*<=>@~])/);
        if (commandMatch) {
            result.commandName = commandMatch[1];
        }
        else {
            result.commandName = inputStream.match(/.*/)[0];
        }
        return result;
    },
    parseLineSpec_: function (cm, inputStream) {
        var numberMatch = inputStream.match(/^(\d+)/);
        if (numberMatch) {
            return parseInt(numberMatch[1], 10) - 1;
        }
        switch (inputStream.next()) {
            case '.':
                return this.parseLineSpecOffset_(inputStream, cm.getCursor().line);
            case '$':
                return this.parseLineSpecOffset_(inputStream, cm.lastLine());
            case '\'':
                var markName = inputStream.next();
                var markPos = getMarkPos(cm, cm.state.vim, markName);
                if (!markPos)
                    throw new Error('Mark not set');
                return this.parseLineSpecOffset_(inputStream, markPos.line);
            case '-':
            case '+':
                inputStream.backUp(1);
                return this.parseLineSpecOffset_(inputStream, cm.getCursor().line);
            default:
                inputStream.backUp(1);
                return undefined;
        }
    },
    parseLineSpecOffset_: function (inputStream, line) {
        var offsetMatch = inputStream.match(/^([+-])?(\d+)/);
        if (offsetMatch) {
            var offset = parseInt(offsetMatch[2], 10);
            if (offsetMatch[1] == "-") {
                line -= offset;
            }
            else {
                line += offset;
            }
        }
        return line;
    },
    parseCommandArgs_: function (inputStream, params, command) {
        if (inputStream.eol()) {
            return;
        }
        params.argString = inputStream.match(/.*/)[0];
        var delim = command.argDelimiter || /\s+/;
        var args = trim(params.argString).split(delim);
        if (args.length && args[0]) {
            params.args = args;
        }
    },
    matchCommand_: function (commandName) {
        for (var i = commandName.length; i > 0; i--) {
            var prefix = commandName.substring(0, i);
            if (this.commandMap_[prefix]) {
                var command = this.commandMap_[prefix];
                if (command.name.indexOf(commandName) === 0) {
                    return command;
                }
            }
        }
        return null;
    },
    buildCommandMap_: function () {
        this.commandMap_ = {};
        for (var i = 0; i < defaultExCommandMap.length; i++) {
            var command = defaultExCommandMap[i];
            var key = command.shortName || command.name;
            this.commandMap_[key] = command;
        }
    },
    map: function (lhs, rhs, ctx, noremap) {
        if (lhs != ':' && lhs.charAt(0) == ':') {
            if (ctx) {
                throw Error('Mode not supported for ex mappings');
            }
            var commandName = lhs.substring(1);
            if (rhs != ':' && rhs.charAt(0) == ':') {
                this.commandMap_[commandName] = {
                    name: commandName,
                    type: 'exToEx',
                    toInput: rhs.substring(1),
                    user: true
                };
            }
            else {
                this.commandMap_[commandName] = {
                    name: commandName,
                    type: 'exToKey',
                    toKeys: rhs,
                    user: true
                };
            }
        }
        else {
            var mapping = {
                keys: lhs,
                type: 'keyToKey',
                toKeys: rhs,
                noremap: !!noremap
            };
            if (ctx) {
                mapping.context = ctx;
            }
            defaultKeymap.unshift(mapping);
        }
    },
    unmap: function (lhs, ctx) {
        if (lhs != ':' && lhs.charAt(0) == ':') {
            if (ctx) {
                throw Error('Mode not supported for ex mappings');
            }
            var commandName = lhs.substring(1);
            if (this.commandMap_[commandName] && this.commandMap_[commandName].user) {
                delete this.commandMap_[commandName];
                return true;
            }
        }
        else {
            var keys = lhs;
            for (var i = 0; i < defaultKeymap.length; i++) {
                if (keys == defaultKeymap[i].keys
                    && defaultKeymap[i].context === ctx) {
                    defaultKeymap.splice(i, 1);
                    return true;
                }
            }
        }
    }
};
var exCommands = {
    colorscheme: function (cm, params) {
        if (!params.args || params.args.length < 1) {
            showConfirm(cm, cm.getOption('theme'));
            return;
        }
        cm.setOption('theme', params.args[0]);
    },
    map: function (cm, params, ctx, defaultOnly) {
        var mapArgs = params.args;
        if (!mapArgs || mapArgs.length < 2) {
            if (cm) {
                showConfirm(cm, 'Invalid mapping: ' + params.input);
            }
            return;
        }
        exCommandDispatcher.map(mapArgs[0], mapArgs[1], ctx, defaultOnly);
    },
    imap: function (cm, params) { this.map(cm, params, 'insert'); },
    nmap: function (cm, params) { this.map(cm, params, 'normal'); },
    vmap: function (cm, params) { this.map(cm, params, 'visual'); },
    omap: function (cm, params) { this.map(cm, params, 'operatorPending'); },
    noremap: function (cm, params) { this.map(cm, params, undefined, true); },
    inoremap: function (cm, params) { this.map(cm, params, 'insert', true); },
    nnoremap: function (cm, params) { this.map(cm, params, 'normal', true); },
    vnoremap: function (cm, params) { this.map(cm, params, 'visual', true); },
    onoremap: function (cm, params) { this.map(cm, params, 'operatorPending', true); },
    unmap: function (cm, params, ctx) {
        var mapArgs = params.args;
        if (!mapArgs || mapArgs.length < 1 || !exCommandDispatcher.unmap(mapArgs[0], ctx)) {
            if (cm) {
                showConfirm(cm, 'No such mapping: ' + params.input);
            }
        }
    },
    mapclear: function (cm, params) { vimApi.mapclear(); },
    imapclear: function (cm, params) { vimApi.mapclear('insert'); },
    nmapclear: function (cm, params) { vimApi.mapclear('normal'); },
    vmapclear: function (cm, params) { vimApi.mapclear('visual'); },
    omapclear: function (cm, params) { vimApi.mapclear('operatorPending'); },
    move: function (cm, params) {
        commandDispatcher.processCommand(cm, cm.state.vim, {
            type: 'motion',
            motion: 'moveToLineOrEdgeOfDocument',
            motionArgs: { forward: false, explicitRepeat: true,
                linewise: true },
            repeatOverride: params.line + 1
        });
    },
    set: function (cm, params) {
        var setArgs = params.args;
        var setCfg = params.setCfg || {};
        if (!setArgs || setArgs.length < 1) {
            if (cm) {
                showConfirm(cm, 'Invalid mapping: ' + params.input);
            }
            return;
        }
        var expr = setArgs[0].split('=');
        var optionName = expr[0];
        var value = expr[1];
        var forceGet = false;
        var forceToggle = false;
        if (optionName.charAt(optionName.length - 1) == '?') {
            if (value) {
                throw Error('Trailing characters: ' + params.argString);
            }
            optionName = optionName.substring(0, optionName.length - 1);
            forceGet = true;
        }
        else if (optionName.charAt(optionName.length - 1) == '!') {
            optionName = optionName.substring(0, optionName.length - 1);
            forceToggle = true;
        }
        if (value === undefined && optionName.substring(0, 2) == 'no') {
            optionName = optionName.substring(2);
            value = false;
        }
        var optionIsBoolean = options[optionName] && options[optionName].type == 'boolean';
        if (optionIsBoolean) {
            if (forceToggle) {
                value = !getOption(optionName, cm, setCfg);
            }
            else if (value == undefined) {
                value = true;
            }
        }
        if (!optionIsBoolean && value === undefined || forceGet) {
            var oldValue = getOption(optionName, cm, setCfg);
            if (oldValue instanceof Error) {
                showConfirm(cm, oldValue.message);
            }
            else if (oldValue === true || oldValue === false) {
                showConfirm(cm, ' ' + (oldValue ? '' : 'no') + optionName);
            }
            else {
                showConfirm(cm, '  ' + optionName + '=' + oldValue);
            }
        }
        else {
            var setOptionReturn = setOption(optionName, value, cm, setCfg);
            if (setOptionReturn instanceof Error) {
                showConfirm(cm, setOptionReturn.message);
            }
        }
    },
    setlocal: function (cm, params) {
        params.setCfg = { scope: 'local' };
        this.set(cm, params);
    },
    setglobal: function (cm, params) {
        params.setCfg = { scope: 'global' };
        this.set(cm, params);
    },
    registers: function (cm, params) {
        var regArgs = params.args;
        var registers = vimGlobalState.registerController.registers;
        var regInfo = '----------Registers----------\n\n';
        if (!regArgs) {
            for (var registerName in registers) {
                var text = registers[registerName].toString();
                if (text.length) {
                    regInfo += '"' + registerName + '    ' + text + '\n';
                }
            }
        }
        else {
            var registerName;
            regArgs = regArgs.join('');
            for (var i = 0; i < regArgs.length; i++) {
                registerName = regArgs.charAt(i);
                if (!vimGlobalState.registerController.isValidRegister(registerName)) {
                    continue;
                }
                var register = registers[registerName] || new Register();
                regInfo += '"' + registerName + '    ' + register.toString() + '\n';
            }
        }
        showConfirm(cm, regInfo);
    },
    sort: function (cm, params) {
        var reverse, ignoreCase, unique, number, pattern;
        function parseArgs() {
            if (params.argString) {
                var args = new CodeMirror.StringStream(params.argString);
                if (args.eat('!')) {
                    reverse = true;
                }
                if (args.eol()) {
                    return;
                }
                if (!args.eatSpace()) {
                    return 'Invalid arguments';
                }
                var opts = args.match(/([dinuox]+)?\s*(\/.+\/)?\s*/);
                if (!opts && !args.eol()) {
                    return 'Invalid arguments';
                }
                if (opts[1]) {
                    ignoreCase = opts[1].indexOf('i') != -1;
                    unique = opts[1].indexOf('u') != -1;
                    var decimal = opts[1].indexOf('d') != -1 || opts[1].indexOf('n') != -1 && 1;
                    var hex = opts[1].indexOf('x') != -1 && 1;
                    var octal = opts[1].indexOf('o') != -1 && 1;
                    if (decimal + hex + octal > 1) {
                        return 'Invalid arguments';
                    }
                    number = decimal && 'decimal' || hex && 'hex' || octal && 'octal';
                }
                if (opts[2]) {
                    pattern = new RegExp(opts[2].substr(1, opts[2].length - 2), ignoreCase ? 'i' : '');
                }
            }
        }
        var err = parseArgs();
        if (err) {
            showConfirm(cm, err + ': ' + params.argString);
            return;
        }
        var lineStart = params.line || cm.firstLine();
        var lineEnd = params.lineEnd || params.line || cm.lastLine();
        if (lineStart == lineEnd) {
            return;
        }
        var curStart = new Pos(lineStart, 0);
        var curEnd = new Pos(lineEnd, lineLength(cm, lineEnd));
        var text = cm.getRange(curStart, curEnd).split('\n');
        var numberRegex = pattern ? pattern :
            (number == 'decimal') ? /(-?)([\d]+)/ :
                (number == 'hex') ? /(-?)(?:0x)?([0-9a-f]+)/i :
                    (number == 'octal') ? /([0-7]+)/ : null;
        var radix = (number == 'decimal') ? 10 : (number == 'hex') ? 16 : (number == 'octal') ? 8 : null;
        var numPart = [], textPart = [];
        if (number || pattern) {
            for (var i = 0; i < text.length; i++) {
                var matchPart = pattern ? text[i].match(pattern) : null;
                if (matchPart && matchPart[0] != '') {
                    numPart.push(matchPart);
                }
                else if (!pattern && numberRegex.exec(text[i])) {
                    numPart.push(text[i]);
                }
                else {
                    textPart.push(text[i]);
                }
            }
        }
        else {
            textPart = text;
        }
        function compareFn(a, b) {
            if (reverse) {
                var tmp;
                tmp = a;
                a = b;
                b = tmp;
            }
            if (ignoreCase) {
                a = a.toLowerCase();
                b = b.toLowerCase();
            }
            var anum = number && numberRegex.exec(a);
            var bnum = number && numberRegex.exec(b);
            if (!anum) {
                return a < b ? -1 : 1;
            }
            anum = parseInt((anum[1] + anum[2]).toLowerCase(), radix);
            bnum = parseInt((bnum[1] + bnum[2]).toLowerCase(), radix);
            return anum - bnum;
        }
        function comparePatternFn(a, b) {
            if (reverse) {
                var tmp;
                tmp = a;
                a = b;
                b = tmp;
            }
            if (ignoreCase) {
                a[0] = a[0].toLowerCase();
                b[0] = b[0].toLowerCase();
            }
            return (a[0] < b[0]) ? -1 : 1;
        }
        numPart.sort(pattern ? comparePatternFn : compareFn);
        if (pattern) {
            for (var i = 0; i < numPart.length; i++) {
                numPart[i] = numPart[i].input;
            }
        }
        else if (!number) {
            textPart.sort(compareFn);
        }
        text = (!reverse) ? textPart.concat(numPart) : numPart.concat(textPart);
        if (unique) { // Remove duplicate lines
            var textOld = text;
            var lastLine;
            text = [];
            for (var i = 0; i < textOld.length; i++) {
                if (textOld[i] != lastLine) {
                    text.push(textOld[i]);
                }
                lastLine = textOld[i];
            }
        }
        cm.replaceRange(text.join('\n'), curStart, curEnd);
    },
    vglobal: function (cm, params) {
        this.global(cm, params);
    },
    normal: function (cm, params) {
        var argString = params.argString;
        if (argString && argString[0] == '!') {
            argString = argString.slice(1);
            noremap = true;
        }
        argString = argString.trimStart();
        if (!argString) {
            showConfirm(cm, 'Argument is required.');
            return;
        }
        var line = params.line;
        if (typeof line == 'number') {
            var lineEnd = isNaN(params.lineEnd) ? line : params.lineEnd;
            for (var i = line; i <= lineEnd; i++) {
                cm.setCursor(i, 0);
                doKeyToKey(cm, params.argString.trimStart());
                if (cm.state.vim.insertMode) {
                    exitInsertMode(cm, true);
                }
            }
        }
        else {
            doKeyToKey(cm, params.argString.trimStart());
            if (cm.state.vim.insertMode) {
                exitInsertMode(cm, true);
            }
        }
    },
    global: function (cm, params) {
        var argString = params.argString;
        if (!argString) {
            showConfirm(cm, 'Regular Expression missing from global');
            return;
        }
        var inverted = params.commandName[0] === 'v';
        if (argString[0] === '!' && params.commandName[0] === 'g') {
            inverted = true;
            argString = argString.slice(1);
        }
        var lineStart = (params.line !== undefined) ? params.line : cm.firstLine();
        var lineEnd = params.lineEnd || params.line || cm.lastLine();
        var tokens = splitBySlash(argString);
        var regexPart = argString, cmd;
        if (tokens.length) {
            regexPart = tokens[0];
            cmd = tokens.slice(1, tokens.length).join('/');
        }
        if (regexPart) {
            try {
                updateSearchQuery(cm, regexPart, true /** ignoreCase */, true /** smartCase */);
            }
            catch (e) {
                showConfirm(cm, 'Invalid regex: ' + regexPart);
                return;
            }
        }
        var query = getSearchState(cm).getQuery();
        var matchedLines = [];
        for (var i = lineStart; i <= lineEnd; i++) {
            var line = cm.getLine(i);
            var matched = query.test(line);
            if (matched !== inverted) {
                matchedLines.push(cmd ? cm.getLineHandle(i) : line);
            }
        }
        if (!cmd) {
            showConfirm(cm, matchedLines.join('\n'));
            return;
        }
        var index = 0;
        var nextCommand = function () {
            if (index < matchedLines.length) {
                var lineHandle = matchedLines[index++];
                var lineNum = cm.getLineNumber(lineHandle);
                if (lineNum == null) {
                    nextCommand();
                    return;
                }
                var command = (lineNum + 1) + cmd;
                exCommandDispatcher.processCommand(cm, command, {
                    callback: nextCommand
                });
            }
            else if (cm.releaseLineHandles) {
                cm.releaseLineHandles();
            }
        };
        nextCommand();
    },
    substitute: function (cm, params) {
        if (!cm.getSearchCursor) {
            throw new Error('Search feature not available. Requires searchcursor.js or ' +
                'any other getSearchCursor implementation.');
        }
        var argString = params.argString;
        var tokens = argString ? splitBySeparator(argString, argString[0]) : [];
        var regexPart, replacePart = '', trailing, flagsPart, count;
        var confirm = false; // Whether to confirm each replace.
        var global = false; // True to replace all instances on a line, false to replace only 1.
        if (tokens.length) {
            regexPart = tokens[0];
            if (getOption('pcre') && regexPart !== '') {
                regexPart = new RegExp(regexPart).source; //normalize not escaped characters
            }
            replacePart = tokens[1];
            if (replacePart !== undefined) {
                if (getOption('pcre')) {
                    replacePart = unescapeRegexReplace(replacePart.replace(/([^\\])&/g, "$1$$&"));
                }
                else {
                    replacePart = translateRegexReplace(replacePart);
                }
                vimGlobalState.lastSubstituteReplacePart = replacePart;
            }
            trailing = tokens[2] ? tokens[2].split(' ') : [];
        }
        else {
            if (argString && argString.length) {
                showConfirm(cm, 'Substitutions should be of the form ' +
                    ':s/pattern/replace/');
                return;
            }
        }
        if (trailing) {
            flagsPart = trailing[0];
            count = parseInt(trailing[1]);
            if (flagsPart) {
                if (flagsPart.indexOf('c') != -1) {
                    confirm = true;
                }
                if (flagsPart.indexOf('g') != -1) {
                    global = true;
                }
                if (getOption('pcre')) {
                    regexPart = regexPart + '/' + flagsPart;
                }
                else {
                    regexPart = regexPart.replace(/\//g, "\\/") + '/' + flagsPart;
                }
            }
        }
        if (regexPart) {
            try {
                updateSearchQuery(cm, regexPart, true /** ignoreCase */, true /** smartCase */);
            }
            catch (e) {
                showConfirm(cm, 'Invalid regex: ' + regexPart);
                return;
            }
        }
        replacePart = replacePart || vimGlobalState.lastSubstituteReplacePart;
        if (replacePart === undefined) {
            showConfirm(cm, 'No previous substitute regular expression');
            return;
        }
        var state = getSearchState(cm);
        var query = state.getQuery();
        var lineStart = (params.line !== undefined) ? params.line : cm.getCursor().line;
        var lineEnd = params.lineEnd || lineStart;
        if (lineStart == cm.firstLine() && lineEnd == cm.lastLine()) {
            lineEnd = Infinity;
        }
        if (count) {
            lineStart = lineEnd;
            lineEnd = lineStart + count - 1;
        }
        var startPos = clipCursorToContent(cm, new Pos(lineStart, 0));
        var cursor = cm.getSearchCursor(query, startPos);
        doReplace(cm, confirm, global, lineStart, lineEnd, cursor, query, replacePart, params.callback);
    },
    startinsert: function (cm, params) {
        doKeyToKey(cm, params.argString == '!' ? 'A' : 'i', {});
    },
    redo: CodeMirror.commands.redo,
    undo: CodeMirror.commands.undo,
    write: function (cm) {
        if (CodeMirror.commands.save) {
            CodeMirror.commands.save(cm);
        }
        else if (cm.save) {
            cm.save();
        }
    },
    nohlsearch: function (cm) {
        clearSearchHighlight(cm);
    },
    yank: function (cm) {
        var cur = copyCursor(cm.getCursor());
        var line = cur.line;
        var lineText = cm.getLine(line);
        vimGlobalState.registerController.pushText('0', 'yank', lineText, true, true);
    },
    delete: function (cm, params) {
        var line = params.selectionLine;
        var lineEnd = isNaN(params.selectionLineEnd) ? line : params.selectionLineEnd;
        operators.delete(cm, { linewise: true }, [
            { anchor: new Pos(line, 0),
                head: new Pos(lineEnd + 1, 0) }
        ]);
    },
    join: function (cm, params) {
        var line = params.selectionLine;
        var lineEnd = isNaN(params.selectionLineEnd) ? line : params.selectionLineEnd;
        cm.setCursor(new Pos(line, 0));
        actions.joinLines(cm, { repeat: lineEnd - line }, cm.state.vim);
    },
    delmarks: function (cm, params) {
        if (!params.argString || !trim(params.argString)) {
            showConfirm(cm, 'Argument required');
            return;
        }
        var state = cm.state.vim;
        var stream = new CodeMirror.StringStream(trim(params.argString));
        while (!stream.eol()) {
            stream.eatSpace();
            var count = stream.pos;
            if (!stream.match(/[a-zA-Z]/, false)) {
                showConfirm(cm, 'Invalid argument: ' + params.argString.substring(count));
                return;
            }
            var sym = stream.next();
            if (stream.match('-', true)) {
                if (!stream.match(/[a-zA-Z]/, false)) {
                    showConfirm(cm, 'Invalid argument: ' + params.argString.substring(count));
                    return;
                }
                var startMark = sym;
                var finishMark = stream.next();
                if (isLowerCase(startMark) && isLowerCase(finishMark) ||
                    isUpperCase(startMark) && isUpperCase(finishMark)) {
                    var start = startMark.charCodeAt(0);
                    var finish = finishMark.charCodeAt(0);
                    if (start >= finish) {
                        showConfirm(cm, 'Invalid argument: ' + params.argString.substring(count));
                        return;
                    }
                    for (var j = 0; j <= finish - start; j++) {
                        var mark = String.fromCharCode(start + j);
                        delete state.marks[mark];
                    }
                }
                else {
                    showConfirm(cm, 'Invalid argument: ' + startMark + '-');
                    return;
                }
            }
            else {
                delete state.marks[sym];
            }
        }
    }
};
var exCommandDispatcher = new ExCommandDispatcher();
function doReplace(cm, confirm, global, lineStart, lineEnd, searchCursor, query, replaceWith, callback) {
    cm.state.vim.exMode = true;
    var done = false;
    var lastPos, modifiedLineNumber, joined;
    function replaceAll() {
        cm.operation(function () {
            while (!done) {
                replace();
                next();
            }
            stop();
        });
    }
    function replace() {
        var text = cm.getRange(searchCursor.from(), searchCursor.to());
        var newText = text.replace(query, replaceWith);
        var unmodifiedLineNumber = searchCursor.to().line;
        searchCursor.replace(newText);
        modifiedLineNumber = searchCursor.to().line;
        lineEnd += modifiedLineNumber - unmodifiedLineNumber;
        joined = modifiedLineNumber < unmodifiedLineNumber;
    }
    function findNextValidMatch() {
        var lastMatchTo = lastPos && copyCursor(searchCursor.to());
        var match = searchCursor.findNext();
        if (match && !match[0] && lastMatchTo && cursorEqual(searchCursor.from(), lastMatchTo)) {
            match = searchCursor.findNext();
        }
        return match;
    }
    function next() {
        while (findNextValidMatch() &&
            isInRange(searchCursor.from(), lineStart, lineEnd)) {
            if (!global && searchCursor.from().line == modifiedLineNumber && !joined) {
                continue;
            }
            cm.scrollIntoView(searchCursor.from(), 30);
            cm.setSelection(searchCursor.from(), searchCursor.to());
            lastPos = searchCursor.from();
            done = false;
            return;
        }
        done = true;
    }
    function stop(close) {
        if (close) {
            close();
        }
        cm.focus();
        if (lastPos) {
            cm.setCursor(lastPos);
            var vim = cm.state.vim;
            vim.exMode = false;
            vim.lastHPos = vim.lastHSPos = lastPos.ch;
        }
        if (callback) {
            callback();
        }
    }
    function onPromptKeyDown(e, _value, close) {
        CodeMirror.e_stop(e);
        var keyName = vimKeyFromEvent(e);
        switch (keyName) {
            case 'y':
                replace();
                next();
                break;
            case 'n':
                next();
                break;
            case 'a':
                var savedCallback = callback;
                callback = undefined;
                cm.operation(replaceAll);
                callback = savedCallback;
                break;
            case 'l':
                replace();
            case 'q':
            case '<Esc>':
            case '<C-c>':
            case '<C-[>':
                stop(close);
                break;
        }
        if (done) {
            stop(close);
        }
        return true;
    }
    next();
    if (done) {
        showConfirm(cm, 'No matches for ' + query.source);
        return;
    }
    if (!confirm) {
        replaceAll();
        if (callback) {
            callback();
        }
        return;
    }
    showPrompt(cm, {
        prefix: dom('span', 'replace with ', dom('strong', replaceWith), ' (y/n/a/q/l)'),
        onKeyDown: onPromptKeyDown
    });
}
function exitInsertMode(cm, keepCursor) {
    var vim = cm.state.vim;
    var macroModeState = vimGlobalState.macroModeState;
    var insertModeChangeRegister = vimGlobalState.registerController.getRegister('.');
    var isPlaying = macroModeState.isPlaying;
    var lastChange = macroModeState.lastInsertModeChanges;
    if (!isPlaying) {
        cm.off('change', onChange);
        if (vim.insertEnd)
            vim.insertEnd.clear();
        vim.insertEnd = null;
        CodeMirror.off(cm.getInputField(), 'keydown', onKeyEventTargetKeyDown);
    }
    if (!isPlaying && vim.insertModeRepeat > 1) {
        repeatLastEdit(cm, vim, vim.insertModeRepeat - 1, true /** repeatForInsert */);
        vim.lastEditInputState.repeatOverride = vim.insertModeRepeat;
    }
    delete vim.insertModeRepeat;
    vim.insertMode = false;
    if (!keepCursor) {
        cm.setCursor(cm.getCursor().line, cm.getCursor().ch - 1);
    }
    cm.setOption('keyMap', 'vim');
    cm.setOption('disableInput', true);
    cm.toggleOverwrite(false); // exit replace mode if we were in it.
    insertModeChangeRegister.setText(lastChange.changes.join(''));
    CodeMirror.signal(cm, "vim-mode-change", { mode: "normal" });
    if (macroModeState.isRecording) {
        logInsertModeChange(macroModeState);
    }
}
function _mapCommand(command) {
    defaultKeymap.unshift(command);
}
function mapCommand(keys, type, name, args, extra) {
    var command = { keys: keys, type: type };
    command[type] = name;
    command[type + "Args"] = args;
    for (var key in extra)
        command[key] = extra[key];
    _mapCommand(command);
}
defineOption('insertModeEscKeysTimeout', 200, 'number');
function executeMacroRegister(cm, vim, macroModeState, registerName) {
    var register = vimGlobalState.registerController.getRegister(registerName);
    if (registerName == ':') {
        if (register.keyBuffer[0]) {
            exCommandDispatcher.processCommand(cm, register.keyBuffer[0]);
        }
        macroModeState.isPlaying = false;
        return;
    }
    var keyBuffer = register.keyBuffer;
    var imc = 0;
    macroModeState.isPlaying = true;
    macroModeState.replaySearchQueries = register.searchQueries.slice(0);
    for (var i = 0; i < keyBuffer.length; i++) {
        var text = keyBuffer[i];
        var match, key;
        while (text) {
            match = (/<\w+-.+?>|<\w+>|./).exec(text);
            key = match[0];
            text = text.substring(match.index + key.length);
            vimApi.handleKey(cm, key, 'macro');
            if (vim.insertMode) {
                var changes = register.insertModeChanges[imc++].changes;
                vimGlobalState.macroModeState.lastInsertModeChanges.changes =
                    changes;
                repeatInsertModeChanges(cm, changes, 1);
                exitInsertMode(cm);
            }
        }
    }
    macroModeState.isPlaying = false;
}
function logKey(macroModeState, key) {
    if (macroModeState.isPlaying) {
        return;
    }
    var registerName = macroModeState.latestRegister;
    var register = vimGlobalState.registerController.getRegister(registerName);
    if (register) {
        register.pushText(key);
    }
}
function logInsertModeChange(macroModeState) {
    if (macroModeState.isPlaying) {
        return;
    }
    var registerName = macroModeState.latestRegister;
    var register = vimGlobalState.registerController.getRegister(registerName);
    if (register && register.pushInsertModeChanges) {
        register.pushInsertModeChanges(macroModeState.lastInsertModeChanges);
    }
}
function logSearchQuery(macroModeState, query) {
    if (macroModeState.isPlaying) {
        return;
    }
    var registerName = macroModeState.latestRegister;
    var register = vimGlobalState.registerController.getRegister(registerName);
    if (register && register.pushSearchQuery) {
        register.pushSearchQuery(query);
    }
}
function onChange(cm, changeObj) {
    var macroModeState = vimGlobalState.macroModeState;
    var lastChange = macroModeState.lastInsertModeChanges;
    if (!macroModeState.isPlaying) {
        var vim = cm.state.vim;
        while (changeObj) {
            lastChange.expectCursorActivityForChange = true;
            if (lastChange.ignoreCount > 1) {
                lastChange.ignoreCount--;
            }
            else if (changeObj.origin == '+input' || changeObj.origin == 'paste'
                || changeObj.origin === undefined /* only in testing */) {
                var selectionCount = cm.listSelections().length;
                if (selectionCount > 1)
                    lastChange.ignoreCount = selectionCount;
                var text = changeObj.text.join('\n');
                if (lastChange.maybeReset) {
                    lastChange.changes = [];
                    lastChange.maybeReset = false;
                }
                if (text) {
                    if (cm.state.overwrite && !/\n/.test(text)) {
                        lastChange.changes.push([text]);
                    }
                    else {
                        if (text.length > 1) {
                            var insertEnd = vim && vim.insertEnd && vim.insertEnd.find();
                            var cursor = cm.getCursor();
                            if (insertEnd && insertEnd.line == cursor.line) {
                                var offset = insertEnd.ch - cursor.ch;
                                if (offset > 0 && offset < text.length) {
                                    lastChange.changes.push([text, offset]);
                                    text = '';
                                }
                            }
                        }
                        if (text)
                            lastChange.changes.push(text);
                    }
                }
            }
            changeObj = changeObj.next;
        }
    }
}
function onCursorActivity(cm) {
    var vim = cm.state.vim;
    if (vim.insertMode) {
        var macroModeState = vimGlobalState.macroModeState;
        if (macroModeState.isPlaying) {
            return;
        }
        var lastChange = macroModeState.lastInsertModeChanges;
        if (lastChange.expectCursorActivityForChange) {
            lastChange.expectCursorActivityForChange = false;
        }
        else {
            lastChange.maybeReset = true;
            if (vim.insertEnd)
                vim.insertEnd.clear();
            vim.insertEnd = cm.setBookmark(cm.getCursor(), { insertLeft: true });
        }
    }
    else if (!cm.curOp.isVimOp) {
        handleExternalSelection(cm, vim);
    }
}
function handleExternalSelection(cm, vim, keepHPos) {
    var anchor = cm.getCursor('anchor');
    var head = cm.getCursor('head');
    if (vim.visualMode && !cm.somethingSelected()) {
        exitVisualMode(cm, false);
    }
    else if (!vim.visualMode && !vim.insertMode && cm.somethingSelected()) {
        vim.visualMode = true;
        vim.visualLine = false;
        CodeMirror.signal(cm, "vim-mode-change", { mode: "visual" });
    }
    if (vim.visualMode) {
        var headOffset = !cursorIsBefore(head, anchor) ? -1 : 0;
        var anchorOffset = cursorIsBefore(head, anchor) ? -1 : 0;
        head = offsetCursor(head, 0, headOffset);
        anchor = offsetCursor(anchor, 0, anchorOffset);
        vim.sel = {
            anchor: anchor,
            head: head
        };
        updateMark(cm, vim, '<', cursorMin(head, anchor));
        updateMark(cm, vim, '>', cursorMax(head, anchor));
    }
    else if (!vim.insertMode && !keepHPos) {
        vim.lastHPos = cm.getCursor().ch;
    }
}
function InsertModeKey(keyName, e) {
    this.keyName = keyName;
    this.key = e.key;
    this.ctrlKey = e.ctrlKey;
    this.altKey = e.altKey;
    this.metaKey = e.metaKey;
    this.shiftKey = e.shiftKey;
}
function onKeyEventTargetKeyDown(e) {
    var macroModeState = vimGlobalState.macroModeState;
    var lastChange = macroModeState.lastInsertModeChanges;
    var keyName = CodeMirror.keyName ? CodeMirror.keyName(e) : e.key;
    if (!keyName) {
        return;
    }
    if (keyName.indexOf('Delete') != -1 || keyName.indexOf('Backspace') != -1) {
        if (lastChange.maybeReset) {
            lastChange.changes = [];
            lastChange.maybeReset = false;
        }
        lastChange.changes.push(new InsertModeKey(keyName, e));
    }
}
function repeatLastEdit(cm, vim, repeat, repeatForInsert) {
    var macroModeState = vimGlobalState.macroModeState;
    macroModeState.isPlaying = true;
    var isAction = !!vim.lastEditActionCommand;
    var cachedInputState = vim.inputState;
    function repeatCommand() {
        if (isAction) {
            commandDispatcher.processAction(cm, vim, vim.lastEditActionCommand);
        }
        else {
            commandDispatcher.evalInput(cm, vim);
        }
    }
    function repeatInsert(repeat) {
        if (macroModeState.lastInsertModeChanges.changes.length > 0) {
            repeat = !vim.lastEditActionCommand ? 1 : repeat;
            var changeObject = macroModeState.lastInsertModeChanges;
            repeatInsertModeChanges(cm, changeObject.changes, repeat);
        }
    }
    vim.inputState = vim.lastEditInputState;
    if (isAction && vim.lastEditActionCommand.interlaceInsertRepeat) {
        for (var i = 0; i < repeat; i++) {
            repeatCommand();
            repeatInsert(1);
        }
    }
    else {
        if (!repeatForInsert) {
            repeatCommand();
        }
        repeatInsert(repeat);
    }
    vim.inputState = cachedInputState;
    if (vim.insertMode && !repeatForInsert) {
        exitInsertMode(cm);
    }
    macroModeState.isPlaying = false;
}
function sendCmKey(cm, key) {
    CodeMirror.lookupKey(key, 'vim-insert', function keyHandler(binding) {
        if (typeof binding == 'string') {
            CodeMirror.commands[binding](cm);
        }
        else {
            binding(cm);
        }
        return true;
    });
}
function repeatInsertModeChanges(cm, changes, repeat) {
    var head = cm.getCursor('head');
    var visualBlock = vimGlobalState.macroModeState.lastInsertModeChanges.visualBlock;
    if (visualBlock) {
        selectForInsert(cm, head, visualBlock + 1);
        repeat = cm.listSelections().length;
        cm.setCursor(head);
    }
    for (var i = 0; i < repeat; i++) {
        if (visualBlock) {
            cm.setCursor(offsetCursor(head, i, 0));
        }
        for (var j = 0; j < changes.length; j++) {
            var change = changes[j];
            if (change instanceof InsertModeKey) {
                sendCmKey(cm, change.keyName, change);
            }
            else if (typeof change == "string") {
                cm.replaceSelection(change);
            }
            else {
                var start = cm.getCursor();
                var end = offsetCursor(start, 0, change[0].length - (change[1] || 0));
                cm.replaceRange(change[0], start, change[1] ? start : end);
                cm.setCursor(end);
            }
        }
    }
    if (visualBlock) {
        cm.setCursor(offsetCursor(head, 0, 1));
    }
}
CodeMirror.Vim = vimApi;
var specialKeyAce = { 'return': 'CR', backspace: 'BS', 'delete': 'Del', esc: 'Esc',
    left: 'Left', right: 'Right', up: 'Up', down: 'Down', space: 'Space', insert: 'Ins',
    home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', enter: 'CR'
};
function lookupKey(hashId, key, e, vim) {
    if (key.length > 1 && key[0] == "n") {
        key = key.replace("numpad", "");
    }
    key = specialKeyAce[key] || key;
    var name = '';
    if (e.ctrlKey) {
        name += 'C-';
    }
    if (e.altKey) {
        name += 'A-';
    }
    if ((name || key.length > 1) && e.shiftKey) {
        name += 'S-';
    }
    if (vim && !vim.expectLiteralNext && key.length == 1) {
        if (langmap.keymap && key in langmap.keymap) {
            if (langmap.remapCtrl !== false || !name)
                key = langmap.keymap[key];
        }
        else if (key.charCodeAt(0) > 255) {
            var code = e.code && e.code.slice(-1) || "";
            if (!e.shiftKey)
                code = code.toLowerCase();
            if (code)
                key = code;
        }
    }
    name += key;
    if (name.length > 1) {
        name = '<' + name + '>';
    }
    return name;
}
var handleKey = vimApi.handleKey.bind(vimApi);
vimApi.handleKey = function (cm, key, origin) {
    return cm.operation(function () {
        return handleKey(cm, key, origin);
    }, true);
};
function cloneVimState(state) {
    var n = new state.constructor();
    Object.keys(state).forEach(function (key) {
        if (key == "insertEnd")
            return;
        var o = state[key];
        if (Array.isArray(o))
            o = o.slice();
        else if (o && typeof o == "object" && o.constructor != Object)
            o = cloneVimState(o);
        n[key] = o;
    });
    if (state.sel) {
        n.sel = {
            head: state.sel.head && copyCursor(state.sel.head),
            anchor: state.sel.anchor && copyCursor(state.sel.anchor)
        };
    }
    return n;
}
function multiSelectHandleKey(cm, key, origin) {
    var isHandled = false;
    var vim = vimApi.maybeInitVimState_(cm);
    var visualBlock = vim.visualBlock || vim.wasInVisualBlock;
    var wasMultiselect = cm.ace.inMultiSelectMode;
    if (vim.wasInVisualBlock && !wasMultiselect) {
        vim.wasInVisualBlock = false;
    }
    else if (wasMultiselect && vim.visualBlock) {
        vim.wasInVisualBlock = true;
    }
    if (key == '<Esc>' && !vim.insertMode && !vim.visualMode && wasMultiselect) {
        cm.ace.exitMultiSelectMode();
    }
    else if (visualBlock || !wasMultiselect || cm.ace.inVirtualSelectionMode) {
        isHandled = vimApi.handleKey(cm, key, origin);
    }
    else {
        var old = cloneVimState(vim);
        var changeQueueList = vim.inputState.changeQueueList || [];
        cm.operation(function () {
            cm.curOp.isVimOp = true;
            var index = 0;
            cm.ace.forEachSelection(function () {
                var sel = cm.ace.selection;
                cm.state.vim.lastHPos = sel.$desiredColumn == null ? sel.lead.column : sel.$desiredColumn;
                cm.state.vim.inputState.changeQueue = changeQueueList[index];
                var head = cm.getCursor("head");
                var anchor = cm.getCursor("anchor");
                var headOffset = !cursorIsBefore(head, anchor) ? -1 : 0;
                var anchorOffset = cursorIsBefore(head, anchor) ? -1 : 0;
                head = offsetCursor(head, 0, headOffset);
                anchor = offsetCursor(anchor, 0, anchorOffset);
                cm.state.vim.sel.head = head;
                cm.state.vim.sel.anchor = anchor;
                isHandled = handleKey(cm, key, origin);
                sel.$desiredColumn = cm.state.vim.lastHPos == -1 ? null : cm.state.vim.lastHPos;
                if (cm.ace.inVirtualSelectionMode) {
                    changeQueueList[index] = cm.state.vim.inputState.changeQueue;
                }
                if (cm.virtualSelectionMode()) {
                    cm.state.vim = cloneVimState(old);
                }
                index++;
            });
            if (cm.curOp.cursorActivity && !isHandled)
                cm.curOp.cursorActivity = false;
            vim.status = cm.state.vim.status;
            cm.state.vim = vim;
            vim.inputState.changeQueueList = changeQueueList;
            vim.inputState.changeQueue = null;
        }, true);
    }
    if (isHandled && !vim.visualMode && !vim.insert && vim.visualMode != cm.somethingSelected()) {
        handleExternalSelection(cm, vim, true);
    }
    return isHandled;
}
resetVimGlobalState();
exports.CodeMirror = CodeMirror;
var getVim = vimApi.maybeInitVimState_;
exports.handler = {
    $id: "ace/keyboard/vim",
    drawCursor: function (element, pixelPos, config, sel, session) {
        var vim = this.state.vim || {};
        var w = config.characterWidth;
        var h = config.lineHeight;
        var top = pixelPos.top;
        var left = pixelPos.left;
        if (!vim.insertMode) {
            var isbackwards = !sel.cursor
                ? session.selection.isBackwards() || session.selection.isEmpty()
                : Range.comparePoints(sel.cursor, sel.start) <= 0;
            if (!isbackwards && left > w)
                left -= w;
        }
        if (!vim.insertMode && vim.status) {
            h = h / 2;
            top += h;
        }
        domLib.translate(element, left, top);
        domLib.setStyle(element.style, "width", w + "px");
        domLib.setStyle(element.style, "height", h + "px");
    },
    $getDirectionForHighlight: function (editor) {
        var cm = editor.state.cm;
        var vim = getVim(cm);
        if (!vim.insertMode) {
            return editor.session.selection.isBackwards() || editor.session.selection.isEmpty();
        }
    },
    handleKeyboard: function (data, hashId, key, keyCode, e) {
        var editor = data.editor;
        var cm = editor.state.cm;
        var vim = getVim(cm);
        if (keyCode == -1)
            return;
        if (!vim.insertMode) {
            if (hashId == -1) {
                if (key.charCodeAt(0) > 0xFF) {
                    if (data.inputKey) {
                        key = data.inputKey;
                        if (key && data.inputHash == 4)
                            key = key.toUpperCase();
                    }
                }
                data.inputChar = key;
            }
            else if (hashId == 4 || hashId == 0) {
                if (data.inputKey == key && data.inputHash == hashId && data.inputChar) {
                    key = data.inputChar;
                    hashId = -1;
                }
                else {
                    data.inputChar = null;
                    data.inputKey = key;
                    data.inputHash = hashId;
                }
            }
            else {
                data.inputChar = data.inputKey = null;
            }
        }
        if (cm.state.overwrite && vim.insertMode && key == "backspace" && hashId == 0) {
            return { command: "gotoleft" };
        }
        if (key == "c" && hashId == 1) { // key == "ctrl-c"
            if (!useragent.isMac && editor.getCopyText()) {
                editor.once("copy", function () {
                    if (vim.insertMode)
                        editor.selection.clearSelection();
                    else
                        cm.operation(function () { exitVisualMode(cm); });
                });
                return { command: "null", passEvent: true };
            }
        }
        if (key == "esc" && !vim.insertMode && !vim.visualMode && !cm.ace.inMultiSelectMode) {
            var searchState = getSearchState(cm);
            var overlay = searchState.getOverlay();
            if (overlay)
                cm.removeOverlay(overlay);
        }
        if (hashId == -1 || hashId & 1 || hashId === 0 && key.length > 1) {
            var insertMode = vim.insertMode;
            var name = lookupKey(hashId, key, e || {}, vim);
            if (vim.status == null)
                vim.status = "";
            var isHandled = multiSelectHandleKey(cm, name, 'user');
            vim = getVim(cm); // may be changed by multiSelectHandleKey
            if (isHandled && vim.status != null)
                vim.status += name;
            else if (vim.status == null)
                vim.status = "";
            cm._signal("changeStatus");
            if (!isHandled && (hashId != -1 || insertMode))
                return;
            return { command: "null", passEvent: !isHandled };
        }
    },
    attach: function (editor) {
        if (!editor.state)
            editor.state = {};
        var cm = new CodeMirror(editor);
        editor.state.cm = cm;
        editor.$vimModeHandler = this;
        enterVimMode(cm);
        getVim(cm).status = null;
        cm.on('vim-command-done', function () {
            if (cm.virtualSelectionMode())
                return;
            getVim(cm).status = null;
            cm.ace._signal("changeStatus");
            cm.ace.session.markUndoGroup();
        });
        cm.on("changeStatus", function () {
            cm.ace.renderer.updateCursor();
            cm.ace._signal("changeStatus");
        });
        cm.on("vim-mode-change", function () {
            if (cm.virtualSelectionMode())
                return;
            updateInputMode();
            cm._signal("changeStatus");
        });
        function updateInputMode() {
            var isIntsert = getVim(cm).insertMode;
            cm.ace.renderer.setStyle("normal-mode", !isIntsert);
            editor.textInput.setCommandMode(!isIntsert);
            editor.renderer.$keepTextAreaAtCursor = isIntsert;
            editor.renderer.$blockCursor = !isIntsert;
        }
        updateInputMode();
        editor.renderer.$cursorLayer.drawCursor = this.drawCursor.bind(cm);
    },
    detach: function (editor) {
        var cm = editor.state.cm;
        leaveVimMode(cm);
        cm.destroy();
        editor.state.cm = null;
        editor.$vimModeHandler = null;
        editor.renderer.$cursorLayer.drawCursor = null;
        editor.renderer.setStyle("normal-mode", false);
        editor.textInput.setCommandMode(false);
        editor.renderer.$keepTextAreaAtCursor = true;
    },
    getStatusText: function (editor) {
        var cm = editor.state.cm;
        var vim = getVim(cm);
        if (vim.insertMode)
            return "INSERT";
        var status = "";
        if (vim.visualMode) {
            status += "VISUAL";
            if (vim.visualLine)
                status += " LINE";
            if (vim.visualBlock)
                status += " BLOCK";
        }
        if (vim.status)
            status += (status ? " " : "") + vim.status;
        return status;
    }
};
vimApi.defineOption({
    name: "wrap",
    set: function (value, cm) {
        if (cm) {
            cm.ace.setOption("wrap", value);
        }
    },
    type: "boolean"
}, false);
vimApi.defineEx('write', 'w', function () {
    console.log(':write is not implemented');
});
defaultKeymap.push({ keys: 'zc', type: 'action', action: 'fold', actionArgs: { open: false } }, { keys: 'zC', type: 'action', action: 'fold', actionArgs: { open: false, all: true } }, { keys: 'zo', type: 'action', action: 'fold', actionArgs: { open: true } }, { keys: 'zO', type: 'action', action: 'fold', actionArgs: { open: true, all: true } }, { keys: 'za', type: 'action', action: 'fold', actionArgs: { toggle: true } }, { keys: 'zA', type: 'action', action: 'fold', actionArgs: { toggle: true, all: true } }, { keys: 'zf', type: 'action', action: 'fold', actionArgs: { open: true, all: true } }, { keys: 'zd', type: 'action', action: 'fold', actionArgs: { open: true, all: true } }, { keys: '<C-A-k>', type: 'action', action: 'aceCommand', actionArgs: { name: "addCursorAbove" } }, { keys: '<C-A-j>', type: 'action', action: 'aceCommand', actionArgs: { name: "addCursorBelow" } }, { keys: '<C-A-S-k>', type: 'action', action: 'aceCommand', actionArgs: { name: "addCursorAboveSkipCurrent" } }, { keys: '<C-A-S-j>', type: 'action', action: 'aceCommand', actionArgs: { name: "addCursorBelowSkipCurrent" } }, { keys: '<C-A-h>', type: 'action', action: 'aceCommand', actionArgs: { name: "selectMoreBefore" } }, { keys: '<C-A-l>', type: 'action', action: 'aceCommand', actionArgs: { name: "selectMoreAfter" } }, { keys: '<C-A-S-h>', type: 'action', action: 'aceCommand', actionArgs: { name: "selectNextBefore" } }, { keys: '<C-A-S-l>', type: 'action', action: 'aceCommand', actionArgs: { name: "selectNextAfter" } });
defaultKeymap.push({
    keys: 'gq',
    type: 'operator',
    operator: 'hardWrap'
});
vimApi.defineOperator("hardWrap", function (cm, operatorArgs, ranges, oldAnchor, newHead) {
    var anchor = ranges[0].anchor.line;
    var head = ranges[0].head.line;
    if (operatorArgs.linewise)
        head--;
    hardWrap(cm.ace, { startRow: anchor, endRow: head });
    return Pos(head, 0);
});
defineOption('textwidth', undefined, 'number', ['tw'], function (width, cm) {
    if (cm === undefined) {
        return;
    }
    if (width === undefined) {
        var value = cm.ace.getOption('printMarginColumn');
        return value;
    }
    else {
        var column = Math.round(width);
        if (column > 1) {
            cm.ace.setOption('printMarginColumn', column);
        }
    }
});
actions.aceCommand = function (cm, actionArgs, vim) {
    cm.vimCmd = actionArgs;
    if (cm.ace.inVirtualSelectionMode)
        cm.ace.on("beforeEndOperation", delayedExecAceCommand);
    else
        delayedExecAceCommand(null, cm.ace);
};
function delayedExecAceCommand(op, ace) {
    ace.off("beforeEndOperation", delayedExecAceCommand);
    var cmd = ace.state.cm.vimCmd;
    if (cmd) {
        ace.execCommand(cmd.exec ? cmd : cmd.name, cmd.args);
    }
    ace.curOp = ace.prevOp;
}
actions.fold = function (cm, actionArgs, vim) {
    cm.ace.execCommand(['toggleFoldWidget', 'toggleFoldWidget', 'foldOther', 'unfoldall'
    ][(actionArgs.all ? 2 : 0) + (actionArgs.open ? 1 : 0)]);
};
defaultKeymapLength = defaultKeymap.length; // ace_patch
exports.handler.defaultKeymap = defaultKeymap;
exports.handler.actions = actions;
exports.Vim = vimApi;

});                (function() {
                    ace.require(["ace/keyboard/vim"], function(m) {
                        if (typeof module == "object" && typeof exports == "object" && module) {
                            module.exports = m;
                        }
                    });
                })();
            