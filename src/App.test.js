import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App.jsx';

describe('ShiftSchedulerApp', () => {
  test('ヘッダーと主要コントロールが表示される', () => {
    render(<App />);
    // ヘッダー
    expect(screen.getByText('シフト自動編成（昼夜同時）')).toBeInTheDocument();
    // 期間パネルの見出し
    expect(screen.getByText('期間（年月・前半/後半）')).toBeInTheDocument();
    // 日別設定パネルの見出し
    expect(screen.getByText('日別設定（昼・夜 必要人数）')).toBeInTheDocument();
    // 条件パネルの見出しとスライダーのラベル
    expect(screen.getByText(/最低充足率:/)).toBeInTheDocument();
    expect(screen.getByText(/候補数:/)).toBeInTheDocument();
    expect(screen.getByText(/同日集約の強さ:/)).toBeInTheDocument();
    // 候補表示パネルの見出し
    expect(screen.getByText('候補スケジュール（昼夜まとめて表示／不足は赤）')).toBeInTheDocument();
  });
});