import eslint from "@eslint/js";
import importX from "eslint-plugin-import-x";
import recommendedPrettierConfig from "eslint-plugin-prettier/recommended";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: {
            import: importX,
        },
        rules: {
            quotes: ["error", "double", { avoidEscape: true, allowTemplateLiterals: false }],
            "no-unused-vars": [
                "error",
                {
                    vars: "all",
                    args: "after-used",
                    ignoreRestSiblings: false,
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                },
            ],
            "import/no-named-as-default": "off",
            "import/no-duplicates": "warn",
            "import/no-extraneous-dependencies": "warn",
            "import/order": ["error", { "newlines-between": "always" }],
            "import/newline-after-import": "warn",
        },
    },
    {
        files: ["src/**/*.ts"],
        rules: {
            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                {
                    vars: "all",
                    args: "after-used",
                    ignoreRestSiblings: true,
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                },
            ],
            "@typescript-eslint/explicit-function-return-type": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-explicit-any": "off",
        },
    },
    {
        files: ["src/test/**/*.test.ts"],
        languageOptions: {
            globals: {
                ...globals.mocha,
            },
        },
    },
    // Must be the last configuration item per project README
    recommendedPrettierConfig,
    // Ignore auto-generated files
    {
        ignores: ["CHANGELOG.md"],
    },
);
