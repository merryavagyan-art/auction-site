/*
 * dc-lite.js — a tiny, dependency-free runtime that renders the exported
 * design pages straight from disk (file://), with no server.
 * It understands the subset of the design format these pages use:
 * {{holes}}, <sc-for>, <sc-if>, event handlers and a Component class with
 * state / setState / renderVals.
 */
(function () {
  'use strict';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
  var WHOLE = /^\{\{\s*([^}]+?)\s*\}\}$/;
  var BOOL_PROPS = { checked: 1, disabled: 1, readonly: 1, selected: 1, multiple: 1, hidden: 1 };

  function DCLogic(props) {
    this.props = props || {};
    this.state = {};
  }
  DCLogic.prototype.setState = function (patch) {
    var next = typeof patch === 'function' ? patch(this.state, this.props) : patch;
    this.state = Object.assign({}, this.state, next || {});
    if (this.__render) this.__render();
  };
  DCLogic.prototype.forceUpdate = function () { if (this.__render) this.__render(); };
  window.DCLogic = DCLogic;

  function lookup(expr, scope) {
    expr = expr.trim();
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (expr === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
    if (/^(['"]).*\1$/.test(expr)) return expr.slice(1, -1);
    var parts = expr.split('.');
    var v = scope[parts[0]];
    for (var i = 1; i < parts.length && v != null; i++) v = v[parts[i]];
    return v;
  }
  function interp(str, scope) {
    return str.replace(HOLE, function (_, e) {
      var v = lookup(e, scope);
      return v == null || v === false ? '' : String(v);
    });
  }

  /* template tree -> virtual nodes */
  function build(nodes, scope, inSvg, out) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (typeof n === 'string') {
        out.push({ text: interp(n, scope) });
        continue;
      }
      var tag = n[0], attrs = n[1], kids = n[2];
      if (tag === 'sc-for') {
        var list = lookup((attrs.list || '').replace(/^\{\{|\}\}$/g, ''), scope) || [];
        var as = attrs.as || 'item';
        for (var k = 0; k < list.length; k++) {
          var s = Object.create(scope);
          s[as] = list[k];
          s.$index = k;
          build(kids, s, inSvg, out);
        }
        continue;
      }
      if (tag === 'sc-if') {
        if (lookup((attrs.value || '').replace(/^\{\{|\}\}$/g, ''), scope)) build(kids, scope, inSvg, out);
        continue;
      }
      var svg = inSvg || tag === 'svg';
      var v = { tag: tag, svg: svg, attrs: {}, props: {}, events: {}, children: [] };
      for (var name in attrs) {
        if (name.indexOf('hint-') === 0) continue;
        var raw = attrs[name];
        var whole = WHOLE.exec(raw);
        if (name.length > 2 && name.indexOf('on') === 0) {
          if (whole) {
            var fn = lookup(whole[1], scope);
            if (typeof fn === 'function') {
              var ev = name.slice(2);
              if (ev === 'change' && tag === 'input' && !/^(checkbox|radio|file)$/i.test(attrs.type || '')) ev = 'input';
              if (ev === 'change' && tag === 'textarea') ev = 'input';
              v.events[ev] = fn;
            }
          }
          continue;
        }
        if (whole) {
          var val = lookup(whole[1], scope);
          if (BOOL_PROPS[name]) { v.props[name] = !!val && val !== 'false'; continue; }
          if (val == null || val === false) continue;
          if (name === 'value' && (tag === 'input' || tag === 'textarea' || tag === 'select')) { v.props.value = String(val); }
          v.attrs[name] = val === true ? '' : String(val);
        } else {
          var str = interp(raw, scope);
          if (name === 'value' && (tag === 'input' || tag === 'textarea')) v.props.value = str;
          if (BOOL_PROPS[name] && !svg) v.props[name] = true;
          v.attrs[name] = str;
        }
      }
      build(kids, scope, svg && tag !== 'foreignObject', v.children);
      out.push(v);
    }
    return out;
  }

  /* virtual nodes -> DOM, reusing existing nodes so focus and clicks survive re-renders */
  function create(v) {
    if ('text' in v) return document.createTextNode(v.text);
    var el = v.svg ? document.createElementNS(SVG_NS, v.tag) : document.createElement(v.tag);
    update(el, v);
    return el;
  }
  function same(el, v) {
    if ('text' in v) return el.nodeType === 3;
    return el.nodeType === 1 && el.localName === v.tag;
  }
  function update(el, v) {
    var old = el.__attrs || {};
    for (var a in old) if (!(a in v.attrs)) el.removeAttribute(a);
    for (var b in v.attrs) if (old[b] !== v.attrs[b] || el.getAttribute(b) !== v.attrs[b]) el.setAttribute(b, v.attrs[b]);
    el.__attrs = v.attrs;
    for (var p in v.props) {
      if (p === 'value') { if (el.value !== v.props.value && document.activeElement !== el) el.value = v.props.value; }
      else if (el[p] !== v.props[p]) el[p] = v.props[p];
    }
    var h = el.__h || (el.__h = {});
    for (var e in h) if (!v.events[e]) { el.removeEventListener(e, h[e].l); delete h[e]; }
    for (var f in v.events) {
      if (!h[f]) {
        var rec = { fn: v.events[f] };
        rec.l = (function (r) { return function (evt) { r.fn(evt); }; })(rec);
        el.addEventListener(f, rec.l);
        h[f] = rec;
      } else h[f].fn = v.events[f];
    }
    patchChildren(el, v.children);
  }
  function patchChildren(parent, vkids) {
    var nodes = parent.childNodes;
    for (var i = 0; i < vkids.length; i++) {
      var cur = nodes[i], v = vkids[i];
      if (!cur) parent.appendChild(create(v));
      else if (!same(cur, v)) parent.replaceChild(create(v), cur);
      else if ('text' in v) { if (cur.nodeValue !== v.text) cur.nodeValue = v.text; }
      else update(cur, v);
    }
    while (parent.childNodes.length > vkids.length) parent.removeChild(parent.lastChild);
  }

  function controls(comp, spec, rerender) {
    var keys = Object.keys(spec).filter(function (k) { return k[0] !== '$' && spec[k] && (spec[k].editor === 'enum' || spec[k].editor === 'boolean'); });
    if (!keys.length) return;
    var box = document.createElement('details');
    box.className = 'dc-controls';
    box.innerHTML = '<summary>Prototype controls</summary>';
    keys.forEach(function (k) {
      var s = spec[k];
      var row = document.createElement('label');
      var title = document.createElement('span');
      title.textContent = k.charAt(0).toUpperCase() + k.slice(1);
      row.appendChild(title);
      var input;
      if (s.editor === 'enum') {
        input = document.createElement('select');
        s.options.forEach(function (o) { var op = document.createElement('option'); op.textContent = o; op.value = o; input.appendChild(op); });
        input.value = comp.props[k];
        input.addEventListener('change', function () { comp.props = Object.assign({}, comp.props); comp.props[k] = input.value; rerender(); });
      } else {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!comp.props[k];
        input.addEventListener('change', function () { comp.props = Object.assign({}, comp.props); comp.props[k] = input.checked; rerender(); });
      }
      row.appendChild(input);
      box.appendChild(row);
    });
    var reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset page';
    reset.addEventListener('click', function () { location.reload(); });
    box.appendChild(reset);
    document.body.appendChild(box);
  }

  window.dcMount = function (Component, tree, spec) {
    var props = {};
    spec = spec || {};
    for (var k in spec) if (k[0] !== '$' && spec[k] && 'default' in spec[k]) props[k] = spec[k].default;
    var root = document.getElementById('dc-root');
    var comp = new Component(props);
    if (!comp.state) comp.state = {};
    var render = function () {
      var vals = comp.renderVals ? comp.renderVals() || {} : {};
      patchChildren(root, build(tree, vals, false, []));
    };
    comp.__render = render;
    render();
    controls(comp, spec, render);
    if (comp.componentDidMount) comp.componentDidMount();
    if (location.hash) {
      var t = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (t) t.scrollIntoView();
    }
  };
})();
