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

-- local total_time = 0
-- local count = 0
local function refresh_highlights()
  -- count = count + 1
  -- local start = vim.loop.hrtime()
  -- global defaults
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

  local global_hls = get_all_hls(0)
  for name, attrs in pairs(global_hls) do
    if not overrides[name] then
      if attrs.link then
        attrs = get_hl(name, 0)
      end
      set_hl(NS, name, attrs)
    end
  end

  for name, attrs in pairs(overrides) do
    set_hl(NS, name, attrs)
  end
  -- local cost = (vim.loop.hrtime() - start) / 1e6
  -- total_time = total_time + cost
  -- print(total_time / count, "ms")
end

-- {{{ called by client
local refresh_timer
local function debounced_refresh_highlights()
  if refresh_timer and refresh_timer:is_active() then
    refresh_timer:close()
  end
  vim.defer_fn(refresh_highlights, 10)
end
-- }}}

-- {{{ autocmds
local group = api.nvim_create_augroup("VSCodeNeovimHighlight", { clear = true })
api.nvim_create_autocmd({ "BufWinEnter", "WinEnter", "FileType" }, {
  group = group,
  callback = function()
    local ns = vim.b.vscode_controlled and NS or 0
    vim.w.__vscode_hl_ns = ns -- debug
    api.nvim_win_set_hl_ns(0, ns)
  end,
})
api.nvim_create_autocmd({ "VimEnter", "ColorScheme", "Syntax", "FileType" }, {
  group = group,
  callback = refresh_highlights,
})
-- }}}

refresh_highlights()

return { refresh = debounced_refresh_highlights }
