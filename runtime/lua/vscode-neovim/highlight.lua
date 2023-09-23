---@diagnostic disable: inject-field

-- Copy global highlights and overrides highlights to the custom namespace, only external buffers use global namespace
local api = vim.api

local NS = api.nvim_create_namespace("-- vscode buffer highlights --")

-- stylua: ignore start
local overrides = {
    NonText     = {}, EndOfBuffer  = {}, ErrorMsg       = {}, MoreMsg      = {}, ModeMsg     = {},
    Question    = {}, VisualNC     = {}, WarningMsg     = {}, Sign         = {}, SignColumn  = {},
    ColorColumn = {}, QuickFixLine = {}, MsgSeparator   = {}, MsgArea      = {}, Operator    = {},
    Delimiter   = {}, Identifier   = {}, SpecialChar    = {}, Number       = {}, Type        = {},
    String      = {}, Error        = {}, Comment        = {}, Constant     = {}, Special     = {},
    Statement   = {}, PreProc      = {}, Underlined     = {}, Ignore       = {}, Todo        = {},
    Character   = {}, Boolean      = {}, Float          = {}, Function     = {}, Conditional = {},
    Repeat      = {}, Label        = {}, Keyword        = {}, Exception    = {}, Include     = {},
    Define      = {}, Macro        = {}, PreCondit      = {}, StorageClass = {}, Structure   = {},
    Typedef     = {}, Tag          = {}, SpecialComment = {}, Debug        = {}, Folded      = {},
    FoldColumn  = {},
}
-- stylua: ignore end

local function get_hl(name, ns)
  ns = ns or 0
  local attrs = api.nvim_get_hl(ns, { name = name, link = false })
  if ns ~= 0 and attrs.link then
    return api.nvim_get_hl(0, { name = name, link = false })
  end
  return attrs
end

local function set_hl(ns, name, attrs)
  ns = ns or 0
  api.nvim_set_hl(ns, name, attrs)
end

local function get_all_hls(ns)
  ns = ns or 0
  return api.nvim_get_hl(ns, { link = false })
end

local function setup_default()
  set_hl(0, "Normal", {})
  set_hl(0, "NormalNC", {})
  set_hl(0, "NormalFloat", {})
  set_hl(0, "NonText", {})
  set_hl(0, "Visual", {})
  set_hl(0, "VisualNOS", {})
  set_hl(0, "Substitute", {})
  set_hl(0, "Whitespace", {})
  set_hl(0, "LineNr", {})
  set_hl(0, "LineNrAbove", {})
  set_hl(0, "LineNrBelow", {})
  set_hl(0, "CursorLine", {})
  set_hl(0, "CursorLineNr", {})
  -- make cursor visible for plugins that use fake cursor
  set_hl(0, "Cursor", { reverse = true })
end

local function refresh_highlights() -- Average processing time: 0.8ms.
  local global_hls = get_all_hls(0)
  local our_hls = get_all_hls(NS)
  for name, attrs in pairs(global_hls) do
    if not overrides[name] then
      if attrs.link then
        attrs = get_hl(name, 0)
      end
      if not (our_hls[name] and vim.deep_equal(our_hls[name], attrs)) then
        set_hl(NS, name, attrs)
      end
    end
  end

  for name, attrs in pairs(overrides) do
    if not (our_hls[name] and vim.deep_equal(our_hls[name], attrs)) then
      set_hl(NS, name, attrs)
    end
  end
end

local function set_win_hl_ns()
  local ok, curr_ns, target_ns, vscode_controlled
  for _, win in ipairs(api.nvim_list_wins()) do
    local buf = api.nvim_win_get_buf(win)

    ok, curr_ns = pcall(api.nvim_win_get_var, win, "_vscode_hl_ns")
    curr_ns = ok and curr_ns or 0

    ok, vscode_controlled = pcall(api.nvim_buf_get_var, buf, "vscode_controlled")
    target_ns = (ok and vscode_controlled) and NS or 0

    if curr_ns ~= target_ns then
      api.nvim_win_set_var(win, "_vscode_hl_ns", target_ns)
      api.nvim_win_set_hl_ns(win, target_ns)
    end
  end
end

-- {{{ autocmds
local group = api.nvim_create_augroup("VSCodeNeovimHighlight", { clear = true })
api.nvim_create_autocmd({ "BufWinEnter", "BufEnter", "WinEnter", "WinNew", "WinScrolled" }, {
  group = group,
  callback = set_win_hl_ns,
})
api.nvim_create_autocmd({ "VimEnter", "ColorScheme", "Syntax", "FileType" }, {
  group = group,
  callback = function()
    setup_default()
    refresh_highlights()
  end,
})
-- }}}

return {
  refresh = (function()
    -- debounce
    local refresh_timer
    return function()
      if refresh_timer and refresh_timer:is_active() then
        refresh_timer:close()
      end
      refresh_timer = vim.defer_fn(refresh_highlights, 100)
    end
  end)(),
}
