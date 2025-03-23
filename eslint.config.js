import { includeIgnoreFile } from "@eslint/compat";
import { fileURLToPath } from "node:url";
import prettier from "eslint-config-prettier";
import tslint from "typescript-eslint";
import jslint from "@eslint/js";
import globals from "globals";

//...

const ignoreFilePath = fileURLToPath(new URL("./.eslint.ignore", import.meta.url));
const ignoreFlatConfig = includeIgnoreFile(ignoreFilePath);

//...

/**
 * Универсальная сборка flat-конфига для 'eslint'
 *
 * Включает в себя:
 * - .eslint.ignore
 * - globals
 * - javascript
 * - typescript
 * - prettier
 *
 * @see https://eslint.org/docs/latest/use/configure/configuration-files
 */
export default tslint.config(
	ignoreFlatConfig,
	jslint.configs.recommended,
	...tslint.configs.recommended,
	prettier,
	{
		languageOptions: {
			globals: globals.node,
		},
	},
	{
		rules: {
			"@typescript-eslint/no-this-alias": 0,
			"@typescript-eslint/no-unused-expressions": 0,
			"@typescript-eslint/no-non-null-asserted-optional-chain": 0,
			"@typescript-eslint/no-empty-object-type": 0,
			"@typescript-eslint/no-explicit-any": 0,
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					args: "all",
					argsIgnorePattern: "^_",
					caughtErrors: "all",
					caughtErrorsIgnorePattern: "^_",
					destructuredArrayIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					ignoreRestSiblings: true,
				},
			],
		},
	}
);
