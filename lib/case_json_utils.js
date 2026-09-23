const fs = require('fs');
const path = require('path');

const safeJsonParse = (value) => {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;

    try {
        return JSON.parse(value);
    } catch (error) {
        return null;
    }
};

const resolveJsonFilePath = (jsonFilePath, baseDir = path.join(__dirname, '..', 'uploads')) => {
    if (!jsonFilePath) return null;

    const normalizedPath = jsonFilePath.replace(/\\/g, '/');
    if (path.isAbsolute(normalizedPath)) {
        return normalizedPath;
    }

    if (normalizedPath.startsWith('uploads/')) {
        return path.join(baseDir, normalizedPath.replace(/^uploads\//, ''));
    }

    return path.join(baseDir, normalizedPath);
};

const resolveCaseJsonData = (caseData, baseDir = path.join(__dirname, '..', 'uploads')) => {
    if (!caseData) return {};

    const directJson = safeJsonParse(caseData.json_data);
    if (directJson) {
        return directJson;
    }

    const jsonFilePath = caseData.json_file_path;
    if (!jsonFilePath) {
        return {};
    }

    try {
        const absolutePath = resolveJsonFilePath(jsonFilePath, baseDir);
        if (!fs.existsSync(absolutePath)) {
            return {};
        }

        const fileContent = fs.readFileSync(absolutePath, 'utf8');
        return safeJsonParse(fileContent) || {};
    } catch (error) {
        return {};
    }
};

const saveJsonUploadToDisk = (file, caseId, baseDir = path.join(__dirname, '..', 'uploads')) => {
    if (!file || !file.buffer) {
        throw new Error('Invalid JSON file upload.');
    }

    const jsonDir = path.join(baseDir, 'json');
    fs.mkdirSync(jsonDir, { recursive: true });

    const fileName = `case-${caseId}-${Date.now()}.json`;
    const absolutePath = path.join(jsonDir, fileName);
    fs.writeFileSync(absolutePath, file.buffer);

    return path.join('uploads', 'json', fileName).replace(/\\/g, '/');
};

module.exports = {
    safeJsonParse,
    resolveCaseJsonData,
    saveJsonUploadToDisk,
    resolveJsonFilePath
};
