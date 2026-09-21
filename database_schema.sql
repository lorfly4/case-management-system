-- Active: 1774493545796@@127.0.0.1@3306@case_management
-- Database: case_management

-- Table: users (untuk Admin, SPV, User)
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  role ENUM('admin', 'spv', 'user') NOT NULL DEFAULT 'user',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Table: cases (untuk semua case dengan 3 tipe)
CREATE TABLE IF NOT EXISTS cases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type ENUM('Regular Case', 'On-Desk Case', 'Reliance Case') NOT NULL,
  title VARCHAR(255) NOT NULL,
  description LONGTEXT,
  status ENUM('Unassigned', 'In Progress', 'On Hold', 'Closed') NOT NULL DEFAULT 'Unassigned',
  priority ENUM('Low', 'Medium', 'High') NOT NULL DEFAULT 'Medium',
  pic_id INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (pic_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Table: case_activities (untuk tracking progress)
CREATE TABLE IF NOT EXISTS case_activities (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  activity_type VARCHAR(100),
  description TEXT,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS case_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  filename VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  uploaded_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Indexes untuk performance
CREATE INDEX idx_cases_type ON cases(type);
CREATE INDEX idx_cases_status ON cases(status);
CREATE INDEX idx_cases_pic_id ON cases(pic_id);
CREATE INDEX idx_cases_created_at ON cases(created_at);
CREATE INDEX idx_case_activities_case_id ON case_activities(case_id);
CREATE INDEX idx_case_documents_case_id ON case_documents(case_id);
