---@diagnostic disable: inject-field

-- Copy global highlights and overrides highlights to the custom namespace, only external buffers use global namespace
local api = vim.api

local NS = api.nvim_create_namespace("-- vscode buffer highlights --")

vim.opt.conceallevel = 0
vim.g.html_ignore_conceal = 1
vim.g.vim_json_conceal = 0

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

local function setup_default()
  api.nvim_set_hl(0, "Normal", {})
  api.nvim_set_hl(0, "NormalNC", {})
  api.nvim_set_hl(0, "NormalFloat", {})
  api.nvim_set_hl(0, "NonText", {})
  api.nvim_set_hl(0, "Visual", {})
  api.nvim_set_hl(0, "VisualNOS", {})
  api.nvim_set_hl(0, "Substitute", {})
  api.nvim_set_hl(0, "Whitespace", {})
  api.nvim_set_hl(0, "LineNr", {})
  api.nvim_set_hl(0, "LineNrAbove", {})
  api.nvim_set_hl(0, "LineNrBelow", {})
  api.nvim_set_hl(0, "CursorLine", {})
  api.nvim_set_hl(0, "CursorLineNr", {})
  -- make cursor visible for plugins that use fake cursor
  api.nvim_set_hl(0, "Cursor", { reverse = true })
end

local function refresh_highlights()
  -- local start = vim.loop.hrtime()
  vim.g.__c__ = (vim.g.__c__ or 0) + 1
  local global_hls = api.nvim_get_hl(0, { link = true })
  for name, attrs in pairs(global_hls) do
    local link = attrs.link
    local target_attrs
    if overrides[name] then
      target_attrs = overrides[name]
    elseif link then
      if overrides[link] then
        target_attrs = overrides[link]
      else
        target_attrs = api.nvim_get_hl(0, { name = link, link = false })
      end
    else
      target_attrs = attrs
    end

    api.nvim_set_hl(NS, name, target_attrs)
  end
  -- print((vim.loop.hrtime() - start) / 1e6, "ms")
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
      refresh_timer = vim.defer_fn(refresh_highlights, 300)
    end
  end)(),
}
